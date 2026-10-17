---
title: What broke while we built on Arkiv
dek: Three places where Arkiv behaved differently than we expected while building Prometheus, each with a repro and a workaround, plus what worked exactly as documented.
date: 2026-10-17
author: The Prometheus team
---

Prometheus watches entities on Arkiv and acts when they expire, change, or appear. To do that, worker A and worker B read Arkiv at every block, write receipts, and worker B checks for worker A's receipts. That pushes a lot of reads and writes through the SDK and the node, which is a good way to find rough edges.

This is our friction log, written for the Arkiv team and for the next builders. Each item covers what we expected, what happened, why it mattered, how we worked around it, and how to reproduce it. None of these stopped us. Each one had a workaround, and we share them so nobody has to find them twice.

## Environment

We measured everything on 15 and 16 October 2026. Unless an item says otherwise, the setup was:

- Tiramisu testnet, one block every 2 seconds
- `@arkiv-network/sdk` 0.8.1
- `viem` 2.57.7
- Node 24.10.0 on macOS

Our probe script is `scripts/probe.ts` in the Prometheus repository. Run it with `npm run probe`. The repro steps below refer to its numbered lines.

## 1. The SDK's `getEntity` is a paid query

**What we expected.** Reading one entity by its key is the cheap, common case. We expected `publicClient.getEntity(key)` to use the cheapest call the node offers.

**What happened.** The SDK implements `getEntity` as an `arkiv_query` with `$key = …`. The node answers with an `arkiv-cost: 100` header, and `arkiv-quota-used-percent` goes up by 1 on every call.

The node also serves a raw `arkiv_getEntity` method. It returns the same data, plus `createdAt` and `updatedAt`. It sends no `arkiv-cost` header, and the quota stays at 0%. The SDK has no wrapper for it, and it is not in `ArkivRpcSchema`.

**Why it mattered.** Our workers read single entities all the time. They confirm that an entity has expired by reading it and getting nothing back, and they check receipts. A worker that checked every receipt through the SDK would burn through its quota in about 100 reads. Query budget is already a known pain on Arkiv: four teams hit it in their friction reports.

**How we worked around it.** We call `arkiv_getEntity` with a raw `fetch` instead of the SDK. Calls that showed no cost in testing could be repriced later. If that happens, the design still works with paid calls under an access key.

**Repro.** Create any entity. Then compare the response headers of these two calls (probe lines `1b` and `1c`):

```text
arkiv_query      ["$key = 0x…", {limit:1}]   arkiv-cost: 100, quota +1% per call
arkiv_getEntity  ["0x…"]                     no arkiv-cost header, quota 0%
```

**Upstream.** [reported-issues #18](https://github.com/Arkiv-Network/reported-issues/issues/18)

**What would help.** A wrapper for `arkiv_getEntity` in the SDK, listed in `ArkivRpcSchema`.

## 2. `eth_getLogs` is capped by block range, not by result count

**What we expected.** Earlier reports described the error as `-32602 … max results 20000`. So we expected replay code to halve its span only when a span returned too many logs.

**What happened.** Asking for every log from block 0 to the latest block fails with a different message, even when few logs match:

```json
{ "code": -32602, "message": "query exceeds max block range 100000" }
```

At 43,200 blocks a day, 100,000 blocks is a little over two days.

**Why it mattered.** Code that matches the documented error message to decide whether to shrink the span misses this one. It gives up instead of retrying.

**How we worked around it.** We match the error code, `-32602`, not the message. We also keep replay chunks at 1,000 blocks or fewer, about 33 minutes of blocks and well under the cap.

**Repro.** Send this request (probe line `6`):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_getLogs",
  "params": [{ "fromBlock": "0x0", "toBlock": "latest" }]
}
```

**What would help.** Documenting the block-range cap and its error message next to the result cap.

## 3. The faucet can't fund a server key

**What we expected.** A way to fund a wallet that exists only as a private key in a `.env` file. Prometheus runs several of these: worker A, worker B, and the relay's sponsor wallet.

**What happened.** The faucet needs a connected browser wallet, a signed sign-in message, and a CAPTCHA. It allows one claim per wallet per hour. There is no CLI or API path.

**Why it mattered.** Server wallets never touch a browser. Yet each one needs funds before it can do its job. The workers pay gas to write receipts and renew entities. The sponsor wallet sends 0.02 GLM once to each new Telegram user, so they can create a subscription.

**How we worked around it.** We imported one key into MetaMask and claimed 10 GLM once. Then we sent funds from that wallet to the others with `cast send`.

**Repro.** Try to claim for an address you hold only as a private key. The faucet asks for a browser wallet connection and a CAPTCHA before it will send anything.

**What would help.** A CLI or API path to the faucet for server keys.

## What worked as documented

We confirmed that these behave as documented:

- **`getEntity` returns everything a watcher needs.** It gives `expiresAt`, `creator`, `owner`, `creationFlags` and typed `attributes` (probe line `1a`). That covers scheduling an expiry warning and spotting a change of owner.
- **Expiry maps cleanly to blocks.** `ExpirationTime.fromMinutes(10)` gave exactly 300 blocks, from `createdAt` 0x991a9 to `expiresAt` 0x992d5. That matches 2-second blocks, so converting between minutes and blocks is reliable.
- **Expiry fires no event, just as the docs say.** This is a deliberate design choice, not a bug. It is the gap Prometheus exists to fill, and the docs stated it plainly, so we could design around it.

## Read more

- The full log: [Friction report](/docs/friction-report)
- The probe script and the rest of the code: [github.com/VanshChitransh/Prometheus](https://github.com/VanshChitransh/Prometheus)
