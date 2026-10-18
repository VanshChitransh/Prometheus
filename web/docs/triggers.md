---
title: Triggers
description: The five triggers a subscription can use, what each needs, when it fires and which receipts it leaves.
status: live
---

A trigger is the condition a subscription watches for. Pick one per subscription. This page lists, for each trigger, when it fires, the attributes it needs, the receipts it can produce and the edge cases worth knowing.

## Which trigger do you want?

| You want to                                            | Trigger     | Receipts it can produce                                   |
| ------------------------------------------------------ | ----------- | --------------------------------------------------------- |
| Hear before an entity expires                          | `expiring`  | `warned`                                                  |
| Hear once an entity has expired                        | `expired`   | `expired`                                                 |
| Hear when an entity is changed, transferred or deleted | `changed`   | `patched`, `owner_changed`, `deleted`                     |
| Hear about each new entity that matches a search       | `new_match` | `matched`                                                 |
| Keep an entity alive by renewing it before it expires  | `keep`      | `kept`, `keep_skipped`, `keep_failed`, `keeper_low_funds` |

## What every subscription has

A subscription is an entity your wallet creates. Workers read its attributes and payload, and check them with the same code the web form uses, so the form rejects exactly what workers reject. A rejected subscription is ignored: no worker serves it and no receipt is written.

| Attribute     | Type | Required | Allowed values                                          |
| ------------- | ---- | -------- | ------------------------------------------------------- |
| `project`     | str  | yes      | `prometheus`                                            |
| `kind`        | str  | yes      | `subscription`                                          |
| `trigger`     | str  | yes      | `expiring`, `expired`, `changed`, `new_match` or `keep` |
| `max_per_day` | u64  | no       | 1 to 100 alerts per UTC day; 20 if you leave it out     |

- **Payload:** JSON `{ "v": 1, "label": "..." }`. The label is required, can't be blank, and is at most 80 characters. It's public, so don't put personal data in it.
- **Number types:** every number must be stored as a `u64`. An `i32` or `u256` attribute is rejected even if the value is in range, because workers query these fields as `u64`.
- **Lifetime:** the web app offers 1, 7 or 30 days. Once a subscription expires, workers stop acting on it.
- **Per wallet:** workers serve your 20 oldest subscriptions. Newer ones beyond 20 are ignored.

### The daily alert cap

`max_per_day` limits alerts (`warned`, `expired`, `patched`, `owner_changed`, `deleted`, `matched`) per subscription per UTC day, counted across both workers. Keep outcomes don't count toward it.

Past the cap, no receipt is written. An `expiring` or `expired` alert is offered again on every block while its condition holds, so it can still fire after midnight UTC. A `changed` or `new_match` alert over the cap is dropped.

## expiring

**Fires when** the newest block reaches the target's expiry minus `lead_blocks`, while the target still exists. The receipt's `trigger_block` is that block: `expiry − lead_blocks`.

| Attribute     | Type | Required | Allowed values                                             |
| ------------- | ---- | -------- | ---------------------------------------------------------- |
| `target_key`  | key  | yes      | a 32-byte entity key (`0x` + 64 hex characters)            |
| `lead_blocks` | u64  | yes      | 30 to 43,200 (1 minute to 1 day). 300 blocks = 10 minutes. |

**Receipt:** `warned`.

**Edge cases:**

- **A warning time longer than the time left fires at once.** If the target expires in 5 minutes and you ask for 1 hour of warning, the trigger block is already in the past. The receipt's lateness counts from that earlier block, so it shows as late even though it went out at once. Both workers can act in the same moment here, so the Activity page may show it as delivered twice. You still get one DM.
- **A renewal re-arms the warning.** The target's expiry is part of the trigger, so each new expiry is a new trigger. You get a fresh warning before each one.
- **The target must exist** when a worker adds your subscription. If it doesn't, the subscription is rejected.

## expired

**Fires when** the newest block reaches the target's expiry and a free read confirms the target is gone. If the read finds it still there, the worker missed a renewal: it updates its schedule and doesn't fire. The receipt's `trigger_block` is the expiry block, and it reads "not renewed by block X".

| Attribute    | Type | Required | Allowed values                                  |
| ------------ | ---- | -------- | ----------------------------------------------- |
| `target_key` | key  | yes      | a 32-byte entity key (`0x` + 64 hex characters) |

**Receipt:** `expired`.

**Edge cases:**

- **A delete isn't an expiry.** A target that's deleted gets no `expired` receipt. Use `changed` to hear about deletes.
- **The target may already be gone.** `expired` is the only trigger that accepts a target that no longer exists. The worker finds its real expiry block in the chain's logs and writes the receipt, but only if it was created or last renewed within the last 43,200 blocks (1 day). Past that, no receipt is written.
- **Workers that were down catch up.** At startup, a worker looks up targets that expired while it was away, using the same 1-day window.

## changed

**Fires when** the target is patched, transferred to a new owner or deleted. The receipt's `trigger_block` is the block the change happened in.

| Attribute    | Type | Required | Allowed values                                  |
| ------------ | ---- | -------- | ----------------------------------------------- |
| `target_key` | key  | yes      | a 32-byte entity key (`0x` + 64 hex characters) |

**Receipts:**

| Event           | What happened                                                      |
| --------------- | ------------------------------------------------------------------ |
| `patched`       | the target's data or attributes were changed                       |
| `owner_changed` | the target moved to a new owner; the receipt records the new owner |
| `deleted`       | the target was deleted                                             |

**Edge cases:**

- **A renewal isn't a change.** Extending the target's expiry fires nothing here. Use `expiring` or `expired` for expiry.
- **Several changes of one kind in one block make one receipt.** They share a trigger id.
- **The target must exist** when a worker adds your subscription.

## new_match

**Fires when** a new entity is created and matches your search. The receipt's `subject` is the new entity, and its `trigger_block` is the block the entity was created in.

| Attribute      | Type | Required | Allowed values                                                           |
| -------------- | ---- | -------- | ------------------------------------------------------------------------ |
| `target_owner` | addr | no       | an address (`0x` + 40 hex characters): only entities this wallet creates |

No `target_key`: you describe what to watch with a search instead.

**The search** goes in the payload as a JSON tree, never a raw query string:

```json
{
  "v": 1,
  "label": "Room A bookings",
  "search": {
    "and": [
      { "eq": ["project", { "str": "studyroom" }] },
      { "eq": ["kind", { "str": "booking" }] },
      { "startsWith": ["room", "A"] }
    ]
  }
}
```

- **Operators:** `and`, `or`, `not`, `eq`, `gt`, `gte`, `lt`, `lte`, `startsWith`. The node refuses `ne`, `exists` and `hasType`, so they aren't allowed.
- **Values name their type:** `str`, `u64`, `i32`, `addr`, `key`, `bytes32` or `bool`, as in `{ "u64": 4 }`. A bare `4` is rejected, because it would silently match nothing against a `u64` attribute. `startsWith` takes a plain string.
- **Size:** nested at most 3 levels deep, with at most 8 conditions.

**Receipt:** `matched`.

**Edge cases:**

- **New entities only, not edits.** A patch that makes an existing entity match your search isn't seen.
- **Prometheus's own writes don't count.** Entities created by trusted worker wallets, such as receipts, are skipped, so a search can't fire on its own receipts.
- **At most 50 `new_match` subscriptions** are checked for each created entity, oldest first.
- **Entities created while a worker was down are still matched** when it replays the missed blocks. The match is checked against the entity as it is now: the worker doesn't yet pin the count to the creation block (`arkiv_getEntityCount` accepts `block`).

## keep

**Fires when** the newest block reaches the target's expiry minus `lead_blocks`, like `expiring`. Instead of alerting, the worker renews the target. The new expiry is the expiry the worker just read plus `keep_blocks`.

| Attribute     | Type | Required | Allowed values                                                                |
| ------------- | ---- | -------- | ----------------------------------------------------------------------------- |
| `target_key`  | key  | yes      | a 32-byte entity key (`0x` + 64 hex characters)                               |
| `lead_blocks` | u64  | yes      | 30 to 43,200 (1 minute to 1 day)                                              |
| `keep_blocks` | u64  | yes      | more than `lead_blocks`; at least 1,800 (1 hour); at most 1,296,000 (30 days) |

`keep_blocks` must be more than `lead_blocks`, or the target would be due for renewal again the moment it was renewed.

**Receipts:**

| Event              | What happened                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `kept`             | the target was renewed; the renewal and this receipt are in one transaction               |
| `keep_skipped`     | the worker chose not to renew; the receipt's `note` says why (below)                      |
| `keep_failed`      | the chain refused the renewal; the `note` holds the chain's reason, cut to 200 characters |
| `keeper_low_funds` | the worker's balance is under 0.005 GLM, so it stopped renewing until it's refilled       |

**Reasons on a `keep_skipped` receipt:**

| `note`               | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `not_permissionless` | the target wasn't created with `permissionlessExtension`, so only its owner may renew it     |
| `deny_listed`        | the target looks like a canary or heartbeat, or it's one of Prometheus's own entities        |
| `already_extended`   | someone already renewed it past this trigger's window                                        |
| `already_expired`    | the target was already gone when the worker read it, or lapsed before the transaction landed |
| `budget`             | this worker has used its 200 renewals for the UTC day                                        |

**Edge cases:**

- **Canaries and heartbeats are never kept.** A canary or heartbeat is meant to expire when its owner stops, so renewing it would hide that silence. The worker refuses any target whose `kind` or `project` contains `canary`, `heartbeat`, `liveness`, `deadman`, `keepalive` or `watchdog`, with or without a separator, in any case. This is a guess by name: nothing on chain marks an entity as a canary. Your real protection is to create a canary without `permissionlessExtension`, so no one but you can renew it.
- **Only targets that allow anyone to renew.** On Arkiv, someone other than the owner can renew an entity only if it was created with the `permissionlessExtension` flag. Without it, you get `keep_skipped` with `not_permissionless`.
- **Prometheus's own entities are never kept,** including subscriptions. Two public subscriptions keeping each other alive would never end.
- **No double renewals.** Both workers compute the same new expiry block. The second worker re-reads the target first, sees it already renewed, and records `keep_skipped` with `already_extended`. If both send at once, both set the same expiry, so the target is still renewed once.
- **Keeps don't use `max_per_day`.** Skipping a keep would let the target lapse. Each worker has its own limit instead: 200 renewals per UTC day.
- **`budget` and `keeper_low_funds` are about one worker, not the trigger.** Each gets its own trigger id, so the other worker can still renew. The worker that hit the limit writes the receipt once and keeps trying, so a refill or a new day still renews. The relay doesn't send `keeper_low_funds` as a DM: it's a message for the worker's operator, and the Activity page shows it as "Low on funds".
- **Keeps stop when your subscription expires.** Renew the subscription to keep going.

## Next

- [Receipts](./receipts.md): every field on a receipt, and how to read lateness
- [How it works](./how-it-works.md): watch, act and prove, with one alert end to end
- [Limits](./limits.md): every bound in one place
- [Data contract](./data-contract.md): the exact attributes and queries on Arkiv
