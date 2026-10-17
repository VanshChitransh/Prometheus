# Arkiv friction log

Measured 15–16 Oct 2026. Environment for every entry unless noted: Tiramisu testnet, `@arkiv-network/sdk` 0.8.1, `viem` 2.57.7, Node 24.10.0, macOS. Probe script: [`scripts/probe.ts`](../scripts/probe.ts) (`npm run probe`).

---

## 1. The SDK's `getEntity` is a paid query, while the free `arkiv_getEntity` RPC is not exposed

- **Expected:** reading one entity by key is the cheap, common case, so `publicClient.getEntity(key)` uses the cheapest call.
- **Actual:** `getEntity` is implemented as `arkiv_query` with `$key = …`. The node answers with `arkiv-cost: 100` and `arkiv-quota-used-percent` goes up by 1 per call. The node also serves a raw `arkiv_getEntity` method that returns the same data plus `createdAt`/`updatedAt`, with **no** `arkiv-cost` header and quota at 0%. The SDK has no wrapper for it, and it is not in `ArkivRpcSchema`.
- **Impact:** a worker that checks every receipt with the SDK burns its quota on about 100 reads. We call `arkiv_getEntity` with raw `fetch` instead.
- **Repro:** create any entity, then compare the response headers of `arkiv_query ["$key = 0x…", {limit:1}]` and `arkiv_getEntity ["0x…"]` (probe lines `1b` and `1c`).
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

---

## What we confirmed works as documented

- `getEntity` returns `expiresAt`, `creator`, `owner`, `creationFlags` and typed `attributes` (probe line `1a`).
- `ExpirationTime.fromMinutes(10)` gave exactly 300 blocks (`createdAt` 0x991a9 → `expiresAt` 0x992d5), which matches 2-second blocks.
