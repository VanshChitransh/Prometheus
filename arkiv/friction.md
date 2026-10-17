# Arkiv friction log

Measured 15–17 Oct 2026. Environment for every entry unless noted: Tiramisu testnet, `@arkiv-network/sdk` 0.8.1, `viem` 2.57.7, Node 24.10.0, macOS. Probe script: [`scripts/probe.ts`](../scripts/probe.ts) (`npm run probe`).

---

## 1. The SDK's `getEntity` is a paid query, while the free `arkiv_getEntity` RPC is not exposed

- **Expected:** reading one entity by key is the cheap, common case, so `publicClient.getEntity(key)` uses the cheapest call.
- **Actual:** `getEntity` is implemented as `arkiv_query` with `$key = …`. The node answers with `arkiv-cost: 100` and `arkiv-quota-used-percent` goes up by 1 per call. The node also serves a raw `arkiv_getEntity` method that returns the same data plus `createdAt`/`updatedAt`, with **no** `arkiv-cost` header and quota at 0%. The SDK has no wrapper for it, and it is not in `ArkivRpcSchema`.
- **Impact:** a worker that checks every receipt with the SDK burns its quota on about 100 reads. We call `arkiv_getEntity` with raw `fetch` instead.
- **Repro:** create any entity, then compare the response headers of `arkiv_query ["$key = key(0x…)", {limit:"0x1"}]` and `arkiv_getEntity ["0x…"]` (probe lines `1b` and `1c`).
- **Also:** a failed `arkiv_query` still returns `arkiv-cost: 100` (measured 17 Oct). `$key = 0x…` without its `key(…)` type is refused with -32001 and billed all the same.
- **Filed upstream:** [reported-issues #18](https://github.com/Arkiv-Network/reported-issues/issues/18)

## 2. `eth_getLogs` is capped by block range, not by result count

- **Expected (from earlier reports):** `-32602 … max results 20000`, so a replay halves the span only when a span has too many logs.
- **Actual:** `{"code":-32602,"message":"query exceeds max block range 100000"}` for `fromBlock: 0x0, toBlock: latest`, even when few logs match.
- **Impact:** code that matches the documented error **message** to decide whether to shrink the span misses this one and gives up instead of retrying. We match the code (`-32602`) and keep replay chunks at ≤1,000 blocks, well under the cap.
- **Repro:** `eth_getLogs [{"fromBlock":"0x0","toBlock":"latest"}]` (probe line `6`).

## 3. The faucet cannot fund a server key

- **Expected:** a way to fund a wallet that only exists as a private key in `.env`.
- **Actual:** the faucet requires connecting a browser wallet (sign-in message) plus a CAPTCHA; one claim per wallet per hour. There is no CLI or API path.
- **Workaround:** import one key into MetaMask, claim 10 GLM once, then fan out to the other wallets with `cast send`.

## 4. A filtered count needs the raw RPC: the SDK's `getEntityCount()` takes no query

- **Expected:** counts are free, so "did a worker already write this receipt?" is one `getEntityCount(query)`.
- **Actual:** SDK 0.8.1's `getEntityCount()` takes no arguments and returns the chain-wide total, and `ArkivRpcSchema` types `arkiv_getEntityCount` with no parameters. The node does accept `arkiv_getEntityCount [{ "query": "…" }]` and returns the filtered count with no `arkiv-cost` header (measured 16 Oct).
- **Impact:** our dedupe, daily-cap and liveness counts go through a cast on `client.request` (`freeCount` in [`shared/arkiv.ts`](../shared/arkiv.ts)).

## 5. `arkiv_getEntityCount` ignores `atBlock`

- **Expected:** like a query, a count can be asked "as of block N", so a replayed event is checked against the state at its own block.
- **Actual:** the count always reflects the current head (measured 17 Oct).
- **Impact:** a `new_match` event replayed after a restart is counted against today's state. Live counts wait until the HTTP node has reached the event's block.

## 6. Live events can't use the access key, and need their own catch-up

- **Expected:** an authenticated, filterable stream of entity events that survives a reconnect.
- **Actual:**
  - The access key travels only as the `X-API-KEY` header, and viem's `webSocket` transport can't set headers, so subscriptions run on the anonymous quota.
  - `watchEntityEvents` takes no filter: every entity event on the chain arrives, and we filter for our workers' entities ourselves. Passing `fromBlock` switches it from push to polling.
  - After a reconnect, viem restores the subscriptions but doesn't backfill the gap (measured 16 Oct). SDK 0.8.1 doesn't export the entity contract's address (`0x4400…0044`), so our `eth_getLogs` replay hard-codes it and mirrors the SDK's event decoding.
- **Impact:** every app that must not miss an event writes its own stall timer, buffer, checkpoint and replay ([`shared/stream.ts`](../shared/stream.ts), [`shared/replay.ts`](../shared/replay.ts)).

## 7. The Tiramisu chain definition has no `blockTime`

- **Expected:** the SDK's `tiramisu` chain tells viem it makes a block every 2 s.
- **Actual:** `tiramisu.blockTime` is `undefined`, so viem assumes its 4 s default: it polls every 4 s and caches `getBlockNumber` for 4 s, and a head read can lag about 2 blocks (measured 17 Oct).
- **Workaround:** `cacheTime: 0` on our HTTP read client.

---

## What we confirmed works as documented

- `getEntity` returns `expiresAt`, `creator`, `owner`, `creationFlags` and typed `attributes` (probe line `1a`).
- `ExpirationTime.fromMinutes(10)` gave exactly 300 blocks (`createdAt` 0x991a9 → `expiresAt` 0x992d5), which matches 2-second blocks.
