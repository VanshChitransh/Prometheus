---
title: What we learned building on Arkiv
description: The places where Arkiv behaved differently from what we expected while building Prometheus, with repros and workarounds.
status: live
---

**Project:** Prometheus, a decentralized watcher that sends alerts when Arkiv entities expire, change or appear, and can renew them automatically. Two independent workers, a Telegram relay and a web app, all reading and writing Tiramisu.

This report covers every Arkiv surface we used: what we tested, what we expected, what happened, and what would fix it. Every claim was first measured between 15 and 17 October and then **re-tested on 18 October** against the live node, the SDK source and the current docs. Where the re-test contradicted an earlier claim of ours, we corrected or withdrew it; those changes are listed at the end.

## Environment

|              |                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| Network      | Tiramisu testnet, chain ID `7738577`, `https://rpc.tiramisu.db-chain.testnet.arkiv.network`                     |
| SDK          | `@arkiv-network/sdk` 0.8.1 (the latest release on npm)                                                          |
| Client       | `viem` 2.57.7                                                                                                   |
| Runtime      | Node 24.10.0 on macOS; Docker `node:24.10-slim` on two DigitalOcean droplets                                    |
| Probe script | [`scripts/probe.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/scripts/probe.ts) (`npm run probe`) |

**Reproducing:** every repro below is a plain JSON-RPC call. Paste this once, then run the snippets. `KEY` is our worker A's heartbeat entity, which stays live until 23 October; any live entity key works.

```sh
RPC=https://rpc.tiramisu.db-chain.testnet.arkiv.network
KEY=0x4781c90e221bbb96a51e08a4f120f163498194fc4430a1fc7e026f1741a6b353
rpc() { curl -s -D - "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" | grep -iE '^arkiv-cost|^\{'; }
```

## Summary

| #   | Issue                                                                              | Surface          | Severity | Status                                                                                  |
| --- | ---------------------------------------------------------------------------------- | ---------------- | -------- | --------------------------------------------------------------------------------------- |
| 1   | SDK `getEntity` is billed 100 units; the free `arkiv_getEntity` has no SDK wrapper | SDK, RPC pricing | Medium   | Worked around · [filed #18](https://github.com/Arkiv-Network/reported-issues/issues/18) |
| 2   | Live events have no filter, no backfill and no clean way to send an access key     | SDK, WebSocket   | High     | Worked around                                                                           |
| 3   | `arkiv_getEntityCount`: no query in the SDK, unknown fields silently ignored       | SDK, RPC         | Medium   | Worked around                                                                           |
| 4   | `eth_getLogs` has two different caps behind one error code                         | RPC              | Low      | Handled                                                                                 |
| 5   | The `tiramisu` chain definition has no `blockTime`                                 | SDK              | Low      | Worked around                                                                           |
| 6   | The faucet funds the signed-in wallet by default and has no documented API         | Hub faucet       | Low      | Worked around                                                                           |

**If Arkiv fixed one thing first:** issue 2. A filterable, resumable event stream would remove the largest piece of infrastructure every reactive Arkiv app has to rebuild.

---

## 1. SDK `getEntity` is billed 100 units; the free `arkiv_getEntity` has no SDK wrapper

| Surface                          | Severity | Status        | Upstream                                                                                 |
| -------------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------- |
| TypeScript SDK, JSON-RPC pricing | Medium   | Worked around | [reported-issues #18](https://github.com/Arkiv-Network/reported-issues/issues/18) (ours) |

**Expected.** Reading one entity by its key is the most common read, so `publicClient.getEntity(key)` would use the cheapest method the node offers.

**Actual.**

- SDK 0.8.1 implements `getEntity` as an `arkiv_query` for `$key = key(…)` with every field selected and `limit` 1 (`src/actions/public/getEntity.ts`). The node answers with `arkiv-cost: 100`.
- The node also serves `arkiv_getEntity`, which is documented on the JSON-RPC page. It returns the same entity (all fields except `attributeSchema`, which is redundant because each attribute carries its type), with **no** `arkiv-cost` header, and `arkiv-quota-used-percent` does not increase.
- The SDK has no wrapper for `arkiv_getEntity`, and `ArkivRpcSchema` does not declare it.
- The docs publish no per-method prices, so the difference is only visible in response headers.
- A query the node _refuses_ is billed as well: a malformed query returns error -32001 together with `arkiv-cost: 100`.

**Steps to reproduce.**

```sh
rpc arkiv_query "[\"\$key = key($KEY)\",{\"limit\":\"0x1\"}]"   # arkiv-cost: 100
rpc arkiv_getEntity "[\"$KEY\"]"                               # no arkiv-cost header
rpc arkiv_query "[\"\$key = $KEY\",{\"limit\":\"0x1\"}]"        # error -32001, still arkiv-cost: 100
```

**Impact.** Without an access key the budget is 10,000 cost units per IP per window, so about 100 SDK `getEntity` calls exhaust it. Our web app hit this on 18 October: `429 ANON_COST_LIMITED`, `ratelimit: limit=10000, remaining=0`, `retry-after: 2000` (a 33-minute lockout). With an access key the effect is small: 15+ paid queries did not move our monthly quota off 1%.

**Our workaround.** `rawGetEntity` in [`shared/arkiv.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/shared/arkiv.ts) calls `arkiv_getEntity` through a typed cast on `client.request` and decodes the result. Paid queries only list keys; each entity is then read for free. The web app reads through a keyed proxy ([`api/rpc.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/api/rpc.ts)), so visitors never spend their own anonymous budget.

**Suggested fix.** Route `getEntity()` to `arkiv_getEntity` and add the method to `ArkivRpcSchema`. Publish a cost table per method. Do not bill requests that fail to parse.

---

## 2. Live events have no filter, no backfill and no clean way to send an access key

| Surface                                           | Severity | Status        | Upstream                                                                                                                                                  |
| ------------------------------------------------- | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript SDK `watchEntityEvents`, WebSocket RPC | High     | Worked around | [arkiv-sdk-js #112](https://github.com/Arkiv-Network/arkiv-sdk-js/issues/112), [#124](https://github.com/Arkiv-Network/arkiv-sdk-js/issues/124) (others') |

**Expected.** A stream of entity events that we can narrow to the entities we care about, and that does not lose events when the connection drops.

**Actual.**

- **No filter.** `watchEntityEvents` subscribes to every entity event on the chain (about 0.9 events per second on 17 October, mostly other apps). The node itself can filter, since `entityKey` and `owner` are indexed topics and a raw `eth_subscribe` with an `owner` topic worked on 13 October, but the SDK passes only the contract address and event list.
- **Silent switch to polling.** The SDK does not forward viem's `poll` option, so passing `fromBlock` quietly turns the push subscription into HTTP polling (already tracked in #112).
- **No backfill after a reconnect.** When we force-closed the socket, viem re-sent the subscription, but the roughly 4 seconds of events in between were never delivered (16 October). Filling the gap means replaying `eth_getLogs`, yet SDK 0.8.1 exports neither the entity contract address (`0x4400…0044`, internal in `src/consts.ts`) nor the log decoder, so we had to hard-code one and copy the other.
- **Access key over WebSocket.** The docs say the WebSocket endpoint accepts the key in the URL path, and it works (a valid key connects with `101`; an invalid one is refused with `401 INVALID_KEY`). But Arkiv's own [skills known-issues](https://github.com/Arkiv-Network/skills/blob/main/skills/arkiv/references/known-issues.md) call a key in an RPC URL a legacy pattern to avoid, and viem includes the full URL, key and all, in its error messages. viem's `webSocket` transport cannot send the header form, so there is no option that is both supported and safe.

**Steps to reproduce.**

1. Subscribe with `client.watchEntityEvents({ onEntityCreated })` over `webSocket()` and observe events from unrelated owners.
2. Add `fromBlock` and observe `eth_getLogs` polling instead of `eth_subscribe` in the network log.
3. Close the underlying socket for a few seconds while entities are being created; the events from the gap never arrive after the automatic reconnect.
4. Connect to `wss://rpc.tiramisu.db-chain.testnet.arkiv.network/<access-key>`, then trigger a socket error: viem's error message prints the URL with the key.

**Impact.** Every app that must not miss an event has to build the same machinery. For us this is the largest single piece of infrastructure in the project:

```text
watchEntityEvents (every event on the chain)
  |                    |
  |                    | no new head for 15 s, or a socket error
  |                    v
  |                  stall: freeze the checkpoint
  |                    v
  |                  eth_getLogs replay: checkpoint to head,
  |                  at most 1,000 blocks per call
  v                    |
filter: is this entity ours? <---+
  v
handle the event
  v
save the checkpoint (block number)
```

**Our workaround.** A stall timer, an event buffer, a per-block checkpoint and a chunked `eth_getLogs` replay ([`shared/stream.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/shared/stream.ts), [`shared/replay.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/shared/replay.ts)). In a failover rehearsal on 17 October we cut worker B's network for 40 seconds; it logged `no head for 15s: stall → resubscribe`, replayed 28 blocks and still delivered every alert on time ([submission.md](https://github.com/VanshChitransh/Prometheus/blob/main/arkiv/submission.md#failover-rehearsal-t54)).

**Suggested fix.** Accept `owner` and `entityKey` filters in `watchEntityEvents` (#124). Support a `fromBlock` that backfills and then switches to push, or expose a resume helper. Export `ARKIV_ADDRESS` and the log decoder. Give the docs and the skills one recommended way to authenticate a WebSocket.

---

## 3. `arkiv_getEntityCount`: no query in the SDK, unknown fields silently ignored

| Surface                  | Severity | Status        | Upstream                                                                                                                           |
| ------------------------ | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript SDK, JSON-RPC | Medium   | Worked around | Listed in Arkiv's [skills known-issues](https://github.com/Arkiv-Network/skills/blob/main/skills/arkiv/references/known-issues.md) |

**Expected.** Counts are free, so questions like "has another worker already written this receipt?" are a single `getEntityCount(query)`, and "as of block N" works the same way it does for `arkiv_query`.

**Actual.**

- SDK 0.8.1's `getEntityCount()` takes no arguments and returns the number of live entities on the whole chain. `ArkivRpcSchema` types the method with no parameters.
- The node accepts `[{ "query": "…", "block": N }]` and returns the filtered count with no `arkiv-cost` header. Its counts matched `arkiv_query`'s row counts on three queries (2, 28 and 98 entities).
- **Unknown fields are silently dropped.** A misspelt field such as `qery` returns the chain-wide total instead of an error. In a deduplication check, that reads as "already written", and the alert is never sent.
- **Two names and two formats for the same idea.** `arkiv_query` takes `atBlock` as a hex string; `arkiv_getEntityCount` takes `block` as a plain number and rejects hex. We passed `atBlock` to the count, the node ignored it without an error, and until we re-tested we wrongly believed counts could not look at past blocks.

**Steps to reproduce.** Our `KEY` entity was created at block 709242.

```sh
rpc arkiv_getEntityCount "[{\"query\":\"\$key = key($KEY)\",\"block\":709241}]"        # 0 (correct)
rpc arkiv_getEntityCount "[{\"query\":\"\$key = key($KEY)\",\"atBlock\":\"0xad279\"}]"  # 1 (atBlock ignored)
rpc arkiv_getEntityCount "[{\"qery\":\"\$key = key($KEY)\"}]"                          # ~29,000 (typo ignored)
```

**Our workaround.** `freeCount` in [`shared/arkiv.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/shared/arkiv.ts), a cast on `client.request`, used for receipt deduplication, the per-subscriber daily cap, worker liveness and new-entity matching.

**Suggested fix.** Add `getEntityCount({ query, block })` to the SDK. Reject unknown fields with -32602, as `arkiv_query`'s options already do. Use one name and one encoding for "as of block" across all methods.

---

## 4. `eth_getLogs` has two different caps behind one error code

| Surface  | Severity | Status  | Upstream  |
| -------- | -------- | ------- | --------- |
| JSON-RPC | Low      | Handled | Not filed |

**Expected.** One documented limit, and one error to handle when a log range is too large.

**Actual.** Two limits, both reported as `-32602`:

- more than 100,000 blocks: `"query exceeds max block range 100000"`, with no hint;
- more than 20,000 logs: `"query exceeds max results 20000, retry with the range 717805-725749"`, which helpfully names a smaller range.

The 20,000-log cap is documented in Arkiv's skills (`limits.md`). The 100,000-block cap is not, and a request from block 0 hits it even when only a few logs match.

**Steps to reproduce.**

```sh
rpc eth_getLogs '[{"fromBlock":"0x0","toBlock":"latest"}]'   # max block range 100000
# any ~20,000-block range near the head:                       max results 20000, retry with the range …
```

**Our workaround.** We match the error code (`-32602`, or HTTP 413), never the message text, fetch at most 1,000 blocks per call and halve the range on a capacity error ([`shared/replay.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/shared/replay.ts)).

**Suggested fix.** Document both caps, and add the same "retry with the range" hint to the block-range error.

---

## 5. The `tiramisu` chain definition has no `blockTime`

| Surface                                      | Severity | Status        | Upstream  |
| -------------------------------------------- | -------- | ------------- | --------- |
| TypeScript SDK (`@arkiv-network/sdk/chains`) | Low      | Worked around | Not filed |

**Expected.** The SDK's `tiramisu` chain declares its 2-second block time, so viem's polling and caching follow the real chain. The last 200 blocks averaged 2.00 s.

**Actual.** `tiramisu.blockTime` is `undefined`. viem then assumes 12-second blocks and caps polling at 4 seconds, so it polls every 4 seconds and caches `getBlockNumber()` for 4 seconds. In 40 reads, the cached head was current 8 times, 1 block behind 19 times and 2 blocks behind 13 times. The definition also has no `blockExplorers` entry, so explorer links have to be hard-coded.

**Steps to reproduce.**

```ts
import { tiramisu } from "@arkiv-network/sdk/chains";
console.log(tiramisu.blockTime, tiramisu.blockExplorers); // undefined undefined
```

**Impact.** Small, and limited to `getBlockNumber()`. It mattered to us because workers ask "has the HTTP node reached block N yet?" before reading.

**Our workaround.** `cacheTime: 0` on our HTTP read client ([`shared/arkiv.ts`](https://github.com/VanshChitransh/Prometheus/blob/main/shared/arkiv.ts)).

**Suggested fix.** Set `blockTime: 2000` and `blockExplorers` on `tiramisu`. The SDK already holds the value internally (`BLOCK_TIME = 2` in `src/consts.ts`).

---

## 6. The faucet funds the signed-in wallet by default and has no documented API

| Surface    | Severity | Status        | Upstream  |
| ---------- | -------- | ------------- | --------- |
| Hub faucet | Low      | Worked around | Not filed |

**Expected.** A clear way to fund a server wallet that exists only as a private key.

**Actual.** A claim requires a Sign-In-With-Ethereum session and a proof-of-work CAPTCHA (`POST /api/faucet` returns `401` without a session), and there is no documented API. A server wallet _can_ be funded by pasting its address into **Send to**, but that field defaults to the signed-in wallet. On 18 October we sent about 16 GLM to the wrong wallet because we didn't change it.

**Our workaround.** One 10 GLM claim on 15 October, then `cast send` to our other wallets within the same minute (visible on chain from the faucet wallet `0x815a…c712`). For end users, our relay sponsors a small amount of GLM so they don't need the faucet at all.

**Suggested fix.** Leave **Send to** empty by default, or show which wallet will be funded next to the button.

---

## Surfaces we used

| Surface              | How we used it                                                                       | Experience                                                               |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| TypeScript SDK 0.8.1 | Writes (create, extend, batch), typed queries, `watchEntityEvents`, `ExpirationTime` | Writes and query building were smooth; read gaps in issues 1, 2, 3 and 5 |
| Direct JSON-RPC      | `arkiv_getEntity`, `arkiv_getEntityCount`, `eth_getLogs` replay                      | Works; quirks in issues 1, 3 and 4                                       |
| WebSocket events     | Live entity events for both workers and the relay                                    | Reliable once wrapped; see issue 2                                       |
| Access keys (Hub)    | One key per worker and one for the relay, sent as `X-API-KEY`                        | Smooth. One key per wallet per network, as documented                    |
| Faucet (Hub)         | Initial funding                                                                      | See issue 6                                                              |
| Block explorer       | Links from every receipt in the web app                                              | Works; routes had to be hard-coded (issue 5)                             |
| Docs and skills      | Query syntax, JSON-RPC reference, `realtime.md` replay pattern                       | Accurate where we checked; the skills' replay pattern shaped ours        |

## Tested and working as documented

| What we tested                                          | Expected                                                 | Observed                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ExpirationTime.fromMinutes(10)`                        | 300 blocks at 2 s per block                              | Exactly 300 (`createdAt` 0x991a9 → `expiresAt` 0x992d5)                                                             |
| `arkiv_getEntity` on an expired, deleted or unknown key | `null`                                                   | `null`                                                                                                              |
| `executeBatch` with an extend and a create              | Both apply or neither does                               | Atomic; we use it to renew an entity and write its receipt together                                                 |
| `permissionlessExtension`                               | A non-owner can extend                                   | Our workers extended entities they don't own (+150 and +2,000 blocks)                                               |
| Extending to an earlier expiry                          | Rejected                                                 | Rejected with a clear message: "already expires at block 1000403, so extending it to 741203 would shorten its life" |
| Malformed query                                         | A specific error                                         | -32001 "a hex literal must carry its type — write addr(0x…), key(0x…), bytes32(0x…) or u256(0x…)"                   |
| `arkiv_query` cursor pages                              | Pinned to one block                                      | Consistent snapshot across pages                                                                                    |
| Rate-limit responses in a browser                       | Headers readable by the page                             | `Retry-After`, `RateLimit` and `Arkiv-Cost` are exposed through CORS                                                |
| Expiry as a liveness signal                             | A stopped worker's 30-minute heartbeat entity lapses     | Lapsed 26.5 minutes after the stop; the relay dropped the worker from `/health`                                     |
| Two workers, one shared state on Arkiv                  | Worker B covers what worker A misses, with no duplicates | 8 of 8 alerts written by B, each exactly 15 blocks late, 0 duplicates                                               |

## Corrections to our earlier log

Re-testing on 18 October showed that four of our earlier claims were wrong. We corrected them rather than keep claims we could not reproduce.

| Earlier claim                                               | What is actually true                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `arkiv_getEntityCount` ignores `atBlock`                    | Counts support past blocks through a field named `block`; `atBlock` is silently ignored (now issue 3)                                 |
| Live events cannot use an access key                        | The WebSocket endpoint accepts the key in the URL path; the real problem is that the key then leaks into error messages (now issue 2) |
| `eth_getLogs` is capped by block range, not by result count | Both caps exist (now issue 4)                                                                                                         |
| The faucet cannot fund a server key                         | It can, through "Send to" (now issue 6)                                                                                               |

Issue 1 was also corrected: an earlier version said the quota rose 1% per paid call and that `arkiv_getEntity` returned extra fields. Neither held on re-test. Our upstream report [#18](https://github.com/Arkiv-Network/reported-issues/issues/18) carries the same two errors, and its repro uses the untyped `$key = 0x…`, which the node refuses; we will post a correction there.

## Next

- [Network](./network.md): the endpoints and costs these findings apply to.
- [Data contract](./data-contract.md): how Prometheus calls the free methods.
- [Run a worker](./run-a-worker.md): funding a worker wallet from the faucet.
