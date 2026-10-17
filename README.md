# Prometheus

Watch and keep alive entities on [Arkiv](https://arkiv.network): workers watch for expiry, changes and new matches, write public receipts on Arkiv, and a relay delivers them to Telegram.

Work in progress.

## Run

Requires Node 24+.

```bash
npm ci
cp .env.example .env   # fill in the values
npm run check && npm test
```

## Deploy

Worker A, the relay and HTTPS run on one Docker host with [`compose.yaml`](compose.yaml) (live: a DigitalOcean droplet). Worker B goes on a different host, so one outage can't stop both.

| Service    | Runs                        | Disk (`./state/…`)                     | Public    |
| ---------- | --------------------------- | -------------------------------------- | --------- |
| `worker-a` | `node worker/index.ts`      | checkpoint, unsent receipts, heartbeat | no        |
| `relay`    | `node relay/index.ts`       | follows (`relay.db`) + checkpoint      | via caddy |
| `caddy`    | HTTPS proxy to `relay:8080` | the certificate                        | 80, 443   |

The `state` folders must survive redeploys: losing the relay's means every Telegram follow is gone.

On the host, next to `compose.yaml`, create (`chmod 600`; never commit or bake them into the image):

- `.env.worker-a`: `ARKIV_HTTP`, `ARKIV_WS`, `TRUSTED_WORKERS`, `ARKIV_ACCESS_KEY`, `WORKER_PRIVATE_KEY`, `WORKER_DELAY_BLOCKS=0`
- `.env.relay`: `ARKIV_HTTP`, `ARKIV_WS`, `TRUSTED_WORKERS`, `ARKIV_ACCESS_KEY`, `SPONSOR_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`
- `.env`: `RELAY_HOST=<ip-with-dashes>.sslip.io` (or your own domain pointed at the host)

```bash
docker compose up -d --build        # first deploy and every update
curl https://$RELAY_HOST/health     # worker A listed in workersAlive
```

Firewall: inbound 22, 80 (certificate challenge), 443 only. Stop any local copy of worker A or the relay first: two worker A's race for nonces, and two relays make Telegram refuse the bot's polling.

### Worker B

Same image, its own droplet in another region (live: DigitalOcean `sfo2`; A is in `nyc1`), so a host or datacenter outage can't take both. It serves nothing, so its firewall allows inbound SSH (22) only. It needs no compose file:

- `.env.worker-b` (`chmod 600`): the same variables as `.env.worker-a`, with B's own `ARKIV_ACCESS_KEY` and `WORKER_PRIVATE_KEY`, and `WORKER_DELAY_BLOCKS=15`

```bash
docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t prometheus .
docker run -d --name worker-b --init --restart unless-stopped --stop-timeout 10 \
  --log-opt max-size=10m --log-opt max-file=3 \
  --env-file .env.worker-b -v "$PWD/state/worker-b:/app/state" \
  prometheus node worker/index.ts
```

`--init` and the log options match `compose.yaml`. To update: rebuild, then `docker rm -f worker-b` and run it again (the state folder keeps its place). Deploy the same commit to both workers. `/health` on the relay lists both once B is up.

## Known limits

What Prometheus doesn't do yet, found by our own audit on 17 Oct. Arkiv-side friction is in [`arkiv/friction.md`](arkiv/friction.md).

- **WK-4:** After a restart, `expired` is written only if the target's last create or extend was in the last 24 h.
- **WK-9:** A worker restart resets its daily keep budget.
- **WK-12:** A receipt sent just before a crash may be written twice; the relay sends one DM.
- **WK-13:** A transient RPC error during startup exits the worker; the container restart brings it back.
- **WK-14:** A subscription renewed during a re-sync may use its old expiry for up to an hour.
- **WK-15:** `new_match` evaluates at most 50 subscriptions per entity; past about 45 distinct searches, event handling lags.
- **RL-2:** Labels are user-written. The bot shows them on one line, at most 80 characters, without link previews; a label can still name a domain.
- **RL-6:** A sponsor transfer that is broadcast but never mined is not re-offered; that user is pointed to the faucet.
- **RL-7:** Alert DMs are sent at most once. A DM still waiting when the relay crashes, or still backing off at the 5 s shutdown limit, or failing for about 8.5 minutes while Telegram is down, is not resent. Receipts on Arkiv and the Status page are unaffected.
- **RL-9:** A `keep_skipped(budget)` DM can be followed by a RENEWED DM from the other worker.
- **RL-10:** Follows from chats that blocked the bot stay until `/stop`; each DM to them fails fast and is dropped.
- **RL-11 / WB-27:** `relay/deliver.ts` (about 300 lines) and the web view (`.tsx`) files exceed the 200-line rule; the web's logic lives in ≤200-line `.ts` modules with tests.
- **OP-3:** `/health` is checked by hand; Docker restarts the relay only when it exits.
- **WB-20:** `#/new`'s 20-per-wallet check counts every live subscription of the wallet, including ones workers reject.
- **WB-21:** The site loads telegram.org's Mini App script on every visit; where telegram.org is blocked, the page waits for it to time out.
- **WB-22:** In Telegram on iPhone, Export key may not copy; the key stays in Telegram's secure storage.
- **WB-23:** After you make a browser key, MetaMask needs a click on each visit.
- **WB-24:** The lifetime ruler keeps moving when reduced motion is on.
- **WB-26:** Receipts show relative time and lateness in blocks, not the exact trigger block or the worker address; `#/mine` doesn't mark public monitors.
- **WB-28:** `#/mine` can label a subscription "served" while its target is gone.

## License

MIT
