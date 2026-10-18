# Prometheus: submission evidence

Everything here can be checked by anyone against the Tiramisu testnet. Wallet roles and every query are in [schema.md](schema.md).

## Why Arkiv

**What breaks without it**

- **Postgres or our own API:** subscriptions would live in our database. If we went down, so would every alert, and a second operator couldn't serve users it never saw sign up. On Arkiv, worker B reads subscriptions that worker A never touched, and anyone can run a worker.
- **IPFS:** no expiry, no attribute queries and no `$creator`. We'd need an indexer to find subscriptions and could not prove who signed a receipt.
- **A subgraph:** it can index writes, but Arkiv sends no event when an entity expires. That silent moment is exactly what we watch. A subgraph would also be one more server for us to run.

**What only Arkiv gives us**

- **Expiry as a primitive.** The thing we watch (expiring entities) and our own liveness (a 30-minute heartbeat entity) both run on it. If a worker dies, Arkiv deletes its heartbeat for us.
- **`$creator` as proof.** The user signs their subscription, so we can't forge one. Workers sign receipts, so anyone can check who delivered and whether a trigger was covered twice.
- **Queryable attributes with no indexer.** Workers spot new subscriptions, and check each other's receipts, with free counts (startup and hourly discovery use a paid `arkiv_query`). The web app reads Arkiv from the browser (through a keyed proxy, falling back to the public RPC), so status pages still work with our backend down.

**What stays off Arkiv, and why**

- **Telegram chat IDs and follows** (`relay.db`). They are personal data, so they never go on chain, not even hashed.
- **Sponsor claims and newsletter emails** (`relay.db`). Personal data too: a Telegram user ID linked to a wallet, and email addresses.
- **Delivered trigger IDs** (`relay.db`). A local cache so the relay never DMs the same alert twice. The receipts they point to are on Arkiv.
- **The bot token and all private keys** (worker, sponsor, demo wallets). These are secrets, held in env vars on each host and never written anywhere public.
- **Worker checkpoints and unsent receipts** (`state/`). Each worker's restart bookkeeping. The subscriptions and receipts themselves live on Arkiv.

## Watching other teams' data

Prometheus watches three other buildathon teams' live entities on Tiramisu. We didn't ask them, add anything to their apps, or write to their data: each team published a schema, and Arkiv data is public. Their data and detection are their work; the alerts and receipts are ours.

Watch-only on purpose: every subscription below is `new_match`, `changed`, `expiring` or `expired`, which only read. We never `keep` another team's entity. An extend we send can make the owner's own batch revert (SiteLog's friction note F9), Door Ledger's leases must lapse when its watcher loses sight of a halt, and the rules ban sabotage.

Created 18 Oct 2026 by `npm run watch-others` ([scripts/watch-others.ts](../scripts/watch-others.ts)) from their own wallet, `0x4887d10C82F2B7Bb199F1dcAB28585F751385094`, for 7 days. Both workers logged every one as `added`.

| Team (their schema)                                                                                    | Subscription                         | Trigger                                                            | Key                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [Door Ledger](https://github.com/bongbongcrypto/door-ledger/blob/main/arkiv/schema.md): exchange halts | Every new halt                       | `new_match` on `app = doorledger, kind = lease`, owner = Watcher A | `0x52e0946171f563ed511da848e11d71ab87ab587753edf37b8ee4da1158d9585d` |
|                                                                                                        | Gate ABS deposit halt closed         | `changed` (the lease is deleted on close)                          | `0x669dc1f778da72a176d88285e68e3c6b773b37c2626bf5d6e1b993c417d7fcbd` |
|                                                                                                        | Gate CRO deposit halt closed         | `changed`                                                          | `0x4bf337a71677a570c38e0172647ed98cdf6019dbe810a218789b681be9f13437` |
| [Arkiv Canary](https://gitlab.com/davidj-builds/arkiv-canary): warrant canaries                        | Example Mail Co. dies in 1 h         | `expiring`, lead 1,800 blocks                                      | `0x3a3aab7673ba0a62e12946b38ca5a5675c809fb6a2ad63373eb5cd95d23476e2` |
|                                                                                                        | Example Mail Co. died                | `expired`                                                          | `0xffed7354489c40e6becfa077245d912bc06e0c6caf7ddfbefae2737990f4299d` |
|                                                                                                        | Example Mail Co. renewed             | `changed` (a renewal patches `renewed_at` and `seq`)               | `0xfcca7bc7966a80734038c185cdfb66dfe71990a8dda5ddf9c064d1316c71faca` |
|                                                                                                        | arkiv-canary.sites.tab.bot died      | `expired`                                                          | `0x63b8028a277ad0d199a053719c512be5d1983acfc3c5297ee562e8a23ec3c6f1` |
|                                                                                                        | New canary published                 | `new_match` on `app = arkiv-canary, type = canary`                 | `0x51d773d73a209ab71ec8300c90bfe9dafabc61a58116dfbfb362c38419337ebb` |
| [Switched Off](https://github.com/RohanGlitched/switched-off): Indian internet shutdown orders         | New shutdown order (drills left out) | `new_match` on `app = switched-off, type = record, net = live`     | `0xde809dfaf351e65b53f251bed109ad37f420f7008ed5ea1f383f1aaa1a938652` |

One has already fired: when Door Ledger closed the Gate ABS deposit halt, worker A wrote a `deleted` receipt (`0x57f69e7816550fbb7b6272c109cbed5d63afbc63dd09c5cf400b5497e9b3724e`, block 736073).

See any of them at `https://prometheus-arkiv.vercel.app/s/<key>`; once one fires, its receipts appear there and on the Activity page. Receipts for one: `project = str('prometheus') AND kind = str('receipt') AND subscription = key(<key>)`.

## Failover rehearsal (T5.4)

Worker A (`0x6a693Fd642c1F8F5E78321C2722208A3791eE79B`, delay 0, DigitalOcean nyc1) acts first. Worker B (`0xa70C8245582d173b04cAe453E9fF6D17a6e58294`, delay 15 blocks, DigitalOcean sfo2) acts only on what A missed. The relay runs beside A and stays up throughout.

### Steps

1. `npm run seed`: 6 demo targets (10–30 min) and 8 subscriptions.
2. Stop only worker A (`docker compose stop worker-a`) before the first warn point.
3. Watch B write every receipt, 15 blocks late, one per trigger.
4. Mid-run, cut B's network for 40 s (`docker network disconnect bridge worker-b`, then `connect`): its 15 s stall timer must resubscribe and replay the missed blocks.
5. Wait for A's `worker` entity to lapse (≤ 30 min), so the relay's `/health` drops it.
6. Restart A (`docker compose start worker-a`): it must not write a second receipt for anything B covered.

### Run 1: 17 Oct 2026, A stopped 16:28:58 → restarted 16:55:59 UTC

| Subscription          | Event          | By  | Trigger block | Late (blocks) | Receipt                                                              |
| --------------------- | -------------- | --- | ------------- | ------------- | -------------------------------------------------------------------- |
| Keep canary           | `keep_skipped` | B   | 702483        | 15            | `0x179389f5fc95146d870b1b029d9cc954c773021484d400c33e1fb280a0bcf12a` |
| Booking 1 expiring    | `warned`       | B   | 702486        | 15            | `0x3c9061de9b4beac25f0195d4251fa7bc9ae4108b5882a74b009d19f170af1e6d` |
| Booking 1 expired     | `expired`      | B   | 702636        | 15            | `0xbfb17b7b855f6b96f4df4ed0f1dd0c621c12313d0397c63b32a9c130329b9597` |
| Canary expired        | `expired`      | B   | 702783        | 15            | `0x0c9be69c4c373e36992b8a1b3e1cfc5b785a357c2acaa9345938f7af41e7fb1e` |
| Booking 2 expiring    | `warned`       | B   | 702790        | 15            | `0x6f2bc3aadba3e538499c65cb37096a6155b72818a89b05e7ac99289817eb64b2` |
| Keep community record | `kept`         | B   | 702946        | 15            | `0x2ccf6635cca1e68f0d78bfad7d458f10567924b16afdb264beb7573716139bed` |
| Keep heartbeat        | `keep_skipped` | B   | 702948        | 15            | `0x64dc84bbcd6f96b0e10286d442c70e0b415960324bee274ac6ce9b728eeb3a5a` |
| Booking 3 expiring    | `warned`       | B   | 703093        | 15            | `0x58b03276fb538ec4b655d28abdd870cfcb832057cd06dee2262a99fac1688a5b` |

- **Failover:** all 8 triggers written by B while A was down, each exactly 15 blocks late; no duplicate `trigger_id`.
- **Stall timer:** network cut 16:33:35–16:34:15. B logged `no head for 15s: stall → resubscribe`, then `replayed 28 blocks (702524 → 702551), live`, and still wrote Booking 1 `expired` 15 blocks late.
- **Coverage page:** the rows show "covered by B", with "0 delivered twice" and no gaps.
- **Liveness:** A left the relay's `/health` at 16:55:29 (its entity lapsed, 26.5 min after the stop).
- **Recovery:** A restarted, replayed 816 blocks, and wrote no receipt for any trigger B had covered.
- **Not checked:** one Telegram DM per trigger (no chat followed this run's subscriptions); a second run.

### Check it yourself

Free counts (`arkiv_getEntityCount`), using the queries in [schema.md](schema.md):

- Who wrote a receipt: `arkiv_getEntity <receipt key>` → `creator`.
- No duplicate for a trigger: `project = str('prometheus') AND kind = str('receipt') AND trigger_id = bytes32(<id>) AND ($creator = addr(<A>) OR $creator = addr(<B>))` returns 1.
- Lateness: the receipt's `done_block − trigger_block`.
