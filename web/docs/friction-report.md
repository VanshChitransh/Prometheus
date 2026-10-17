---
title: What we learned building on Arkiv
description: The places where Arkiv behaved differently from what we expected while building Prometheus, with repros and workarounds.
status: live
---

These are the rough edges we hit while building Prometheus on Arkiv, each with what we expected, what happened, and how we worked around it. The last section lists what worked exactly as documented.

## Test setup

Measured 15 to 16 Oct 2026. Every entry used this setup unless it says otherwise:

- Tiramisu testnet
- `@arkiv-network/sdk` 0.8.1
- `viem` 2.57.7
- Node 24.10.0 on macOS

The probe script is `scripts/probe.ts` in the [source repo](https://github.com/VanshChitransh/Prometheus). Run it with `npm run probe`.

## 1. The SDK's `getEntity` is a paid query, and the free `arkiv_getEntity` method isn't exposed

- **Expected:** reading one entity by key is the cheap, common case, so `publicClient.getEntity(key)` uses the cheapest call.
- **Actual:** `getEntity` runs `arkiv_query` with `$key = …`. The node answers with `arkiv-cost: 100`, and `arkiv-quota-used-percent` goes up by 1 per call. The node also serves a raw `arkiv_getEntity` method. It returns the same data plus `createdAt` and `updatedAt`, with no `arkiv-cost` header, and the quota stays at 0%. The SDK has no wrapper for it, and it isn't in `ArkivRpcSchema`.
- **Impact:** a worker that checks every receipt through the SDK uses up its quota in about 100 reads.
- **Workaround:** call `arkiv_getEntity` as a raw JSON-RPC request. Prometheus does this for every read by key.
- **Repro:** create any entity, then compare the response headers of `arkiv_query ["$key = 0x…", {limit:1}]` and `arkiv_getEntity ["0x…"]`. These are probe lines `1b` and `1c`.
- **Filed upstream:** [reported-issues #18](https://github.com/Arkiv-Network/reported-issues/issues/18)

## 2. `eth_getLogs` is capped by block range, not by result count

- **Expected (from earlier reports):** the error `-32602 … max results 20000`, so a replay halves its span only when a span has too many logs.
- **Actual:** `{"code":-32602,"message":"query exceeds max block range 100000"}` for `fromBlock: 0x0, toBlock: latest`, even when few logs match.
- **Impact:** code that matches the documented error message to decide whether to shrink the span misses this one, and gives up instead of retrying.
- **Workaround:** match the error code (`-32602`), not the message, and keep replay chunks at 1,000 blocks or fewer, well under the cap.
- **Repro:** `eth_getLogs [{"fromBlock":"0x0","toBlock":"latest"}]`. This is probe line `6`.

- **Filed upstream:** not yet.

## 3. The faucet can't fund a server key

- **Expected:** a way to fund a wallet that only exists as a private key in a `.env` file.
- **Actual:** the faucet needs a browser wallet sign-in (a signed message) and a CAPTCHA, and allows one claim per wallet per hour. There is no command-line or API route.
- **Workaround:** import one key into MetaMask, claim 10 GLM once, then send GLM on to the other wallets with `cast send`.

- **Filed upstream:** not yet.

## What works as documented

- `getEntity` returns `expiresAt`, `creator`, `owner`, `creationFlags` and typed `attributes`. This is probe line `1a`.
- `ExpirationTime.fromMinutes(10)` gave exactly 300 blocks: `createdAt` `0x991a9` to `expiresAt` `0x992d5`. That matches 2-second blocks.

## Next

- [Network](./network.md): the endpoints and costs these findings apply to.
- [Data contract](./data-contract.md): how Prometheus calls the free methods.
- [Run a worker](./run-a-worker.md): funding a worker wallet despite the faucet.
