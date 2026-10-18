---
title: Data contract
description: Every entity Prometheus writes on Arkiv, with each attribute, payload, flag, lifetime and signer, plus the queries that read them back.
status: live
---

Prometheus keeps all of its state on Arkiv as three kinds of entity: subscriptions, receipts and worker heartbeats. This page lists every field, who sets it, how long the entity lives and who signs it. Use it when you write subscriptions from your own code or read receipts without the web app.

## Rules for every entity

- Every entity has `project = "prometheus"` and a `kind`: `subscription`, `receipt` or `worker`. Every query filters on both, so you never read another app's data by accident.
- Attribute names are lowercase snake_case.
- Anything you filter on is an attribute. The payload holds only data for display.
- Numbers that queries compare with `>=` or `<` are `u64`. A number stored as another type, such as `i32`, never matches a `u64` query, so workers reject it.
- Trust comes from `$creator`, never from an attribute. `$creator` is the wallet that created the entity. Arkiv records it; you can't set it. Anyone can write an entity with `kind = "receipt"`, so readers only believe receipts whose `$creator` is a trusted worker.

### Arkiv types used here

| Type      | Holds                                                |
| --------- | ---------------------------------------------------- |
| `str`     | text                                                 |
| `u64`     | a whole number from 0 up, compared with `>=`, `<`    |
| `key`     | a 32-byte entity key: `0x` and 64 hex characters     |
| `addr`    | a 20-byte wallet address: `0x` and 40 hex characters |
| `bytes32` | 32 raw bytes, used for `trigger_id`                  |

## Wallets that create entities

| Role            | Address                                      | Creates                                                                                                        |
| --------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Worker A        | `0x6a693Fd642c1F8F5E78321C2722208A3791eE79B` | `worker`, `receipt`                                                                                            |
| Worker B        | `0xa70C8245582d173b04cAe453E9fF6D17a6e58294` | `worker`, `receipt`                                                                                            |
| Demo publisher  | `0x07df075e19C8682E0BbF4D1B018BA3Ab8fD174F2` | the demo entities that get watched                                                                             |
| Demo subscriber | `0xa286a6fc7bF81CE5A18cFB52CF9C2040724aC8Ee` | demo `subscription`s                                                                                           |
| Any user        | their own wallet                             | `subscription`                                                                                                 |
| Sponsor (relay) | `0x64E80982DEEfe1296CfD6483A30Fd4a46EbA7C22` | no entities in normal operation (three test subscriptions from 18 Oct remain); it only sends small GLM top-ups |

The entity a subscription watches is called the target. It can be any entity on Arkiv, from any app. Prometheus reads it and, for the `keep` trigger, renews it, but never writes its data.

## The three kinds at a glance

| Kind           | Signed by               | Lifetime                                                                      | Flags                                   |
| -------------- | ----------------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| `subscription` | the subscriber's wallet | any; the web app offers 1, 7 or 30 days (43,200, 302,400 or 1,296,000 blocks) | `permissionlessExtension` if you opt in |
| `receipt`      | a worker wallet         | 30 days (1,296,000 blocks)                                                    | `readonly`                              |
| `worker`       | a worker wallet         | 30 minutes (900 blocks), renewed every 10 minutes                             | none                                    |

Flags are set when an entity is created and never change:

- `readonly`: nobody can edit the entity's data or attributes.
- `permissionlessExtension`: any wallet can renew the entity, not only its owner.

## Subscription: "watch this entity for me"

The subscriber sets every attribute. The web app fills them in from its form; your own code can write them directly.

| Attribute      | Type   | Required for                             | Meaning                                                                                                                            |
| -------------- | ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `project`      | `str`  | all                                      | `prometheus`                                                                                                                       |
| `kind`         | `str`  | all                                      | `subscription`                                                                                                                     |
| `trigger`      | `str`  | all                                      | `expiring`, `expired`, `changed`, `new_match` or `keep`                                                                            |
| `target_key`   | `key`  | `expiring`, `expired`, `changed`, `keep` | the entity to watch                                                                                                                |
| `target_owner` | `addr` | `new_match` (optional)                   | only consider new entities created by this wallet                                                                                  |
| `lead_blocks`  | `u64`  | `expiring`, `keep`                       | act this many blocks before the target expires: 30 to 43,200 (1 minute to 1 day)                                                   |
| `keep_blocks`  | `u64`  | `keep`                                   | blocks added to the target's expiry on each renewal: more than `lead_blocks`, at least 1,800 (1 hour), at most 1,296,000 (30 days) |
| `max_per_day`  | `u64`  | none (optional, any trigger)             | most alerts per UTC day: 1 to 100, default 20. The web app doesn't set it, so it gets 20.                                          |

### Payload

JSON with a version and a label. A `new_match` subscription adds `search`: a JSON tree that describes the query, never a raw query string.

```json
{ "v": 1, "label": "Riya's booking" }
```

```json
{
  "v": 1,
  "label": "New bookings",
  "search": {
    "and": [
      { "eq": ["kind", { "str": "booking" }] },
      { "gte": ["seats", { "u64": 2 }] }
    ]
  }
}
```

Search tree rules:

- Each node is an object with exactly one key.
- `and` and `or` take a list of nodes. `not` takes one node.
- `eq`, `gt`, `gte`, `lt` and `lte` take `[name, value]`. `startsWith` takes `[name, "prefix"]`.
- Every value names its type: `str`, `u64`, `i32`, `addr`, `key`, `bytes32` or `bool`. A bare number like `4` is refused, because it would be read as `i32` and silently match nothing against a `u64` attribute.
- At most 3 levels deep and 8 conditions. `ne`, `exists` and `hasType` aren't allowed; the node refuses them.

### Flags, lifetime and signer

- **Flags:** `permissionlessExtension` only if you tick "anyone can renew". Otherwise none.
- **Lifetime:** any; the web app offers 1, 7 or 30 days. Renewing sets the expiry again, counted from now. Arkiv refuses a renewal that wouldn't move the expiry later.
- **Why it expires:** a subscription you forget about ends on its own. Workers stop serving it and nobody has to clean up.
- **Signed by:** you, in your own browser, with MetaMask or a key the web app keeps in your browser. Workers never create subscriptions.

### What workers check

Workers read each subscription when they start, once an hour, and whenever one is created or edited. They ignore it if:

- an attribute is missing, has the wrong type or is out of bounds (see [Limits](./limits.md));
- the payload isn't JSON with `v: 1` and a non-empty `label`;
- the target doesn't exist. Only `expired` may watch a target that has already expired;
- the creator already has 20 older subscriptions. Workers serve each wallet's oldest 20.

The web form runs the same checks, so it shows the same reasons a worker would log.

## Receipt: "this happened, and this worker acted"

A worker sets every attribute.

| Attribute       | Type      | Meaning                                                                            |
| --------------- | --------- | ---------------------------------------------------------------------------------- |
| `project`       | `str`     | `prometheus`                                                                       |
| `kind`          | `str`     | `receipt`                                                                          |
| `trigger_id`    | `bytes32` | the same id on every worker for the same trigger (see below)                       |
| `subscription`  | `key`     | the subscription that asked                                                        |
| `subject`       | `key`     | the target, or for `new_match` the newly created entity                            |
| `event`         | `str`     | what happened; one of the 10 events below                                          |
| `trigger_block` | `u64`     | the block when the condition became true                                           |
| `done_block`    | `u64`     | the block when this worker acted. `done_block − trigger_block` is how late it was. |

### Events

| Event              | Trigger     | What happened                                                                | `trigger_block`                 |
| ------------------ | ----------- | ---------------------------------------------------------------------------- | ------------------------------- |
| `warned`           | `expiring`  | the target is within `lead_blocks` of its expiry                             | target's expiry − `lead_blocks` |
| `expired`          | `expired`   | the target expired                                                           | target's expiry block           |
| `patched`          | `changed`   | the target's data or attributes were edited                                  | the edit's block                |
| `owner_changed`    | `changed`   | the target moved to a new owner                                              | the transfer's block            |
| `deleted`          | `changed`   | the target was deleted                                                       | the deletion's block            |
| `matched`          | `new_match` | a new entity matching the search was created                                 | the creation's block            |
| `kept`             | `keep`      | the worker renewed the target by `keep_blocks`                               | target's expiry − `lead_blocks` |
| `keep_skipped`     | `keep`      | the worker didn't renew; `note` says why                                     | target's expiry − `lead_blocks` |
| `keep_failed`      | `keep`      | Arkiv refused the renewal; `note` holds Arkiv's reason, up to 200 characters | target's expiry − `lead_blocks` |
| `keeper_low_funds` | `keep`      | the worker's balance is below its 0.005 GLM reserve                          | target's expiry − `lead_blocks` |

`keep_skipped` notes:

- `not_permissionless`: the target wasn't created with `permissionlessExtension`, so only its owner can renew it.
- `deny_listed`: the target looks like a dead-man switch, or it is one of Prometheus's own entities. See "Entities the keeper never renews" in [Limits](./limits.md).
- `already_extended`: someone already renewed it past this trigger's window.
- `already_expired`: it expired before the worker could act.
- `budget`: this worker has used its daily renewal budget.

### How `trigger_id` is built

```ts
import { encodePacked, keccak256 } from "viem";

const triggerId = keccak256(
  encodePacked(
    ["bytes32", "bytes32", "string", "uint64"],
    [subscription, subject, event, triggerBlock],
  ),
);
```

Every input is public, so every worker computes the same id for the same trigger. "Did a worker already do this?" becomes one free count (query 2 below).

- For a `keep` trigger, `event` is `"keep"`, not the outcome. Every outcome of one trigger shares one id, so the second worker sees the first's receipt and skips.
- Two outcomes are about one worker, not the trigger, so each gets its own id and the other worker can still act: `keeper_low_funds` (built with event `keeper_low_funds`) and `keep_skipped` with note `budget` (built with event `keep_skipped`).

### Payload

```json
{
  "v": 1,
  "note": "budget",
  "target_creator": "0x07df075e19C8682E0BbF4D1B018BA3Ab8fD174F2",
  "target_owner": "0x07df075e19C8682E0BbF4D1B018BA3Ab8fD174F2"
}
```

- `note`: the reason, for `keep_skipped` and `keep_failed`. Left out otherwise.
- `target_creator`, `target_owner`: the target as the worker last saw it. An entity can be re-created after it expires, so these pin which one was watched.
- There is no transaction field. A `kept` receipt is created in the same transaction as the renewal, so that transaction is the receipt's own creation.

### Flags, lifetime and signer

- **Flags:** `readonly`. A receipt can't be rewritten; its owner could still delete it, but the deletion is publicly logged on chain.
- **Lifetime:** 30 days. Long enough to audit a month of coverage, short enough that old alerts don't stay forever.
- **Signed by:** a worker wallet. Workers send receipts in batches of up to 50 per transaction.

## Worker: "I am alive"

A worker sets every attribute.

| Attribute      | Type  | Value                                                                                             |
| -------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `project`      | `str` | `prometheus`                                                                                      |
| `kind`         | `str` | `worker`                                                                                          |
| `version`      | `str` | the deployed git commit (`GIT_SHA`), e.g. `9182ae9`; `dev` locally                                |
| `operator`     | `str` | `team-a` when `delay_blocks` is 0, otherwise `team-b`. A label only; trust comes from `$creator`. |
| `delay_blocks` | `u64` | how many blocks this worker waits before acting: `0` for worker A, `15` for worker B              |

```json
{
  "name": "prometheus-worker",
  "url": "",
  "triggers": ["expiring", "expired", "changed", "new_match", "keep"]
}
```

- **Flags:** none. Only the worker renews it.
- **Lifetime:** 30 minutes. The worker renews it to 30 minutes from now every 10 minutes.
- **Why:** the expiry is the health check. If a worker stops, it stops renewing, and its entity disappears within 30 minutes. Renewing three times per lifetime survives two missed renewals.
- **Signed by:** the worker wallet, at first start. The worker saves the entity key in `state/worker-key-<address>.json` and reuses it after a restart if the entity is still live and the commit is unchanged.

## Queries

"Free" means the node returns no `arkiv-cost` header for the call (measured 16 Oct 2026). `arkiv_query` costs 100 units: 1% of the anonymous budget (10,000 units per IP per window), so Prometheus keeps paid queries off every hot path.

`TRUSTED` in the queries below is this clause, for the live deployment:

```text
($creator = addr(0x6a693Fd642c1F8F5E78321C2722208A3791eE79B) OR $creator = addr(0xa70C8245582d173b04cAe453E9fF6D17a6e58294))
```

Replace `<…>` with your values. Keys and addresses go in as `0x…` hex inside `key(…)`, `addr(…)` or `bytes32(…)`.

### 1. Discover subscriptions

Workers, at startup and once an hour. `arkiv_query`, paged (paid).

```text
project = str('prometheus') AND kind = str('subscription')
```

### 2. Has a trusted worker acted on this trigger?

Workers, before writing a receipt. `arkiv_getEntityCount` (free).

```text
project = str('prometheus') AND kind = str('receipt') AND trigger_id = bytes32(<trigger id>) AND TRUSTED
```

### 3. Today's alerts for one subscription

Workers, to enforce `max_per_day` after a restart. `arkiv_getEntityCount` (free).

```text
project = str('prometheus') AND kind = str('receipt') AND subscription = key(<subscription key>) AND trigger_block >= u64(<day start block>) AND TRUSTED
```

`<day start block>` is `head − ⌊(now − UTC midnight) / 2 s⌋`, never below 0.

### 4. Receipts for one subscription

Web app, subscription page. `arkiv_query` (paid).

```text
project = str('prometheus') AND kind = str('receipt') AND subscription = key(<subscription key>) AND TRUSTED
```

### 5. Coverage for the last 24 hours

Web app, Activity page (`/activity`). `arkiv_query` (paid).

```text
project = str('prometheus') AND kind = str('receipt') AND trigger_block >= u64(<head − 43200>) AND TRUSTED
```

### 6. My subscriptions

Web app, "mine" page. `arkiv_query` (paid).

```text
project = str('prometheus') AND kind = str('subscription') AND $creator = addr(<your address>)
```

### 7. Live workers

Relay and web app, one count per worker. `arkiv_getEntityCount` (free).

```text
project = str('prometheus') AND kind = str('worker') AND $creator = addr(<worker address>)
```

### Why queries 2 and 3 must carry `TRUSTED`

Anyone can compute a `trigger_id` from public data. Without the `$creator` filter, a fake receipt from any wallet would make both workers skip the real alert, or use up a subscription's daily cap.

### Calling the free methods

Read one entity by key with the raw `arkiv_getEntity` method. It is free and also returns the creation and update blocks. The SDK's `getEntity()` runs a paid `arkiv_query` instead (see the [friction report](./friction-report.md)).

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_getEntity","params":["<entity key>"]}
EOF
```

It returns `null` when no live entity has that key: never created, deleted or expired.

Count matching entities with `arkiv_getEntityCount`. This counts the live workers:

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_getEntityCount","params":[{"query":"project = str('prometheus') AND kind = str('worker') AND ($creator = addr(0x6a693Fd642c1F8F5E78321C2722208A3791eE79B) OR $creator = addr(0xa70C8245582d173b04cAe453E9fF6D17a6e58294))"}]}
EOF
```

The SDK's own `getEntityCount()` sends no query and returns a chain-wide total, so call the method directly as above.

## Next

- [Limits](./limits.md): every bound on these fields, and what happens when you reach it.
- [Receipts](./receipts.md): how to read and verify a receipt.
- [Network](./network.md): endpoints, chain id and the live deployment's addresses.
