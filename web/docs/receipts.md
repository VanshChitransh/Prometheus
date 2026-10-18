---
title: Receipts
description: What a receipt records, how to read its lateness, and how to find the receipts for your subscription.
status: live
---

A receipt is an entity a worker writes on Arkiv every time it acts on a subscription. It says what happened, which worker acted and how late. Anyone can read it, and receipts can't be rewritten; deletion is publicly logged.

## What a receipt is

When a trigger fires, the worker doesn't only send you a message. It writes a receipt entity on Arkiv first. The relay reads that receipt to send your Telegram DM, and the status page reads it to show you the history. So the receipt is the record of what happened, and everything else is built on top of it.

## Fields

### Attributes

These are the fields you can filter on in a query.

| Attribute       | Type    | What it holds                                                                                        |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `project`       | str     | `prometheus`                                                                                         |
| `kind`          | str     | `receipt`                                                                                            |
| `trigger_id`    | bytes32 | a hash of `subscription`, `subject`, `event` and `trigger_block`; every worker computes the same one |
| `subscription`  | key     | the subscription that asked                                                                          |
| `subject`       | key     | the watched target, or the newly created entity for `new_match`                                      |
| `event`         | str     | what happened: one of the 10 events below                                                            |
| `trigger_block` | u64     | the block when the condition became true                                                             |
| `done_block`    | u64     | the block when this worker acted                                                                     |

For a `keep` trigger, the hash uses `keep` as the event, so every outcome of one keep trigger shares one id. Two outcomes are about one worker rather than the trigger, so each gets its own id and the other worker can still act: `keeper_low_funds`, and `keep_skipped` with note `budget`.

### Payload

The payload is JSON, shown but not queried.

| Field            | What it holds                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `v`              | `1`, the payload version                                                                     |
| `note`           | for `keep_skipped`, the reason; for `keep_failed`, the chain's reason (up to 200 characters) |
| `target_creator` | who created the target, as the worker last saw it                                            |
| `target_owner`   | who owned the target, as the worker last saw it                                              |

`target_creator` and `target_owner` pin which entity was watched. After an entity expires, a new one can take its place, so the receipt records the one the worker actually saw.

There's no transaction field. A `kept` receipt is created in the same transaction as the renewal, so that transaction is the receipt's own creation transaction.

### Set by Arkiv

| Field      | Value                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `$creator` | the worker wallet that created the receipt; this is what trust is based on |
| `$owner`   | the same worker wallet                                                     |
| expiry     | 30 days after the receipt was written                                      |
| flags      | `readonly`                                                                 |

## Events

| `event`            | From trigger | The status page shows  | Meaning                                                |
| ------------------ | ------------ | ---------------------- | ------------------------------------------------------ |
| `warned`           | `expiring`   | Warning sent           | the target is within `lead_blocks` of its expiry       |
| `expired`          | `expired`    | Not renewed by block X | the target expired at block X                          |
| `patched`          | `changed`    | Changed                | the target was patched                                 |
| `owner_changed`    | `changed`    | Owner changed          | the target moved to a new owner                        |
| `deleted`          | `changed`    | Deleted                | the target was deleted                                 |
| `matched`          | `new_match`  | New matching record    | a new entity matched the search; it's the `subject`    |
| `kept`             | `keep`       | Kept alive             | the target was renewed                                 |
| `keep_skipped`     | `keep`       | Renewal skipped        | the worker chose not to renew; `note` says why         |
| `keep_failed`      | `keep`       | Renewal failed         | the chain refused the renewal; `note` holds its reason |
| `keeper_low_funds` | `keep`       | Worker low on funds    | the worker's balance is too low to renew               |

See [Triggers](./triggers.md) for when each one fires and the `keep_skipped` reasons.

## Lateness

**Lateness = `done_block − trigger_block`**, in blocks. Multiply by 2 for seconds.

- The status page shows "on time" for a lateness of 0 or 1 block. Otherwise it shows the lateness as time, for example "30 s late" for 15 blocks.
- A receipt from worker B is always at least 15 blocks (30 seconds) late. B waits that long, then acts only if no trusted worker has written the receipt yet. See [Workers and failover](./workers-and-failover.md).
- `done_block` is the block when the worker decided to act. The receipt itself lands a little later: workers send receipts in batches, when 10 are waiting or every 5 blocks (10 seconds).
- An `expiring` subscription whose warning time is longer than the time the target has left fires at once, but its `trigger_block` is in the past. That receipt shows as late even though it went out right away.

## Lifetime and read-only

- **30 days.** A receipt expires 30 days after it's written, and Arkiv deletes it like any other entity. That's long enough to audit a month of coverage, without keeping old alerts forever.
- **Read-only.** Every receipt is created with the `readonly` flag, which blocks edits. The worker that owns it could still delete it, but a delete is an event on the chain that anyone can see. So: receipts can't be rewritten; deletion is publicly logged.

## Who signs it

The worker's wallet signs the transaction that creates the receipt, and Arkiv records that wallet as the receipt's `$creator`.

| Worker   | Address                                      |
| -------- | -------------------------------------------- |
| Worker A | `0x6a693Fd642c1F8F5E78321C2722208A3791eE79B` |
| Worker B | `0xa70C8245582d173b04cAe453E9fF6D17a6e58294` |

## Finding your receipts

You need your subscription's key: the entity key Arkiv gave your subscription when you created it.

### The status page

Open `<site>/s/<key>`. The page reads your subscription and its receipts straight from Arkiv in your browser. It needs no relay and no worker, so it keeps working if they're down. Each receipt shows what happened, its lateness and a link to it on the explorer.

### Telegram

Every DM from the relay links to the subscription's status page, and to the target, the receipt and the transaction on the explorer.

### The explorer

Each receipt has a page at `https://tiramisu.explorer.arkiv.network/entity/<receipt key>`.

### An Arkiv query

To read receipts without any Prometheus code, run this query. It's a paid `arkiv_query` call.

```text
project = str('prometheus') AND kind = str('receipt')
AND subscription = key(<your subscription key>)
AND ($creator = addr(0x6a693Fd642c1F8F5E78321C2722208A3791eE79B)
  OR $creator = addr(0xa70C8245582d173b04cAe453E9fF6D17a6e58294))
```

The same query with the SDK, as the web app builds it:

```ts
import { createPublicClient } from "@arkiv-network/sdk";
import { addr, key } from "@arkiv-network/sdk/attr";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { eq, MAX_LIMIT, or } from "@arkiv-network/sdk/query";
import { http } from "viem";

const client = createPublicClient({
  chain: tiramisu,
  transport: http("https://rpc.tiramisu.db-chain.testnet.arkiv.network"),
});

const page = await client
  .select({ key: true })
  .where(
    eq("project", "prometheus"),
    eq("kind", "receipt"),
    eq("subscription", key("0x<your subscription key>")),
    or([
      eq("$creator", addr("0x6a693Fd642c1F8F5E78321C2722208A3791eE79B")),
      eq("$creator", addr("0xa70C8245582d173b04cAe453E9fF6D17a6e58294")),
    ]),
  )
  .limit(MAX_LIMIT)
  .fetch();
// page.entities: receipt keys. page.hasNextPage() and page.next() walk the rest.
```

The web app then reads each receipt by key with the free raw `arkiv_getEntity` call. See [Data contract](./data-contract.md) for every query Prometheus uses.

## Why "trusted" matters

Anyone can create an entity with `kind = receipt` and any attributes they like. A `trigger_id` is computed from public data, so anyone can also copy a real one. A lookalike receipt is easy to write.

What no one can fake is `$creator`: Arkiv sets it to the wallet that signed the transaction. So every reader decides trust by `$creator`, never by an attribute:

- **Workers** count only trusted receipts when they check "did someone already act?" and when they count today's alerts. A forged receipt can't make both workers skip your alert or use up your daily cap.
- **The relay** sends a DM only for receipts created by a trusted worker.
- **The web app** shows only trusted receipts on the status and Activity pages.

The trusted list is `TRUSTED_WORKERS`, set by whoever runs the relay and builds the site. If you query receipts yourself, always include the `$creator` filter. See [Trust model](./trust-model.md).

## Next

- [Workers and failover](./workers-and-failover.md): why a trigger can have one receipt, or two
- [Trust model](./trust-model.md): who you trust, and what happens if Prometheus disappears
- [Data contract](./data-contract.md): every entity and query on Arkiv
