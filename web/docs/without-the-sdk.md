---
title: Without the SDK
description: Every Prometheus trigger as a plain Arkiv createEntity call, for other languages or when you want to build the entity yourself.
status: live
---

The [Prometheus SDK](./sdk.md) does all of this for you. You don't need it, though: a subscription is a normal Arkiv entity, so anything that can sign an Arkiv `createEntity` can make one. Use this page from another language, or when you want to see exactly what the SDK writes. This page shows every trigger as a `createEntity` call, then renew, cancel and how to check a subscription before you sign it.

## Before you start

An **entity** is one entry in Arkiv, and every entity has an expiry date. A **subscription** is an entity that tells Prometheus's two **workers** what to watch. Each time a worker acts, it writes a **receipt**: another entity, whose `event` attribute says what happened.

You need a wallet client with testnet GLM, set up as in [Quickstart: developers](./quickstart-developers.md). Every example below uses these imports, a `wallet` built with `createWalletClient`, and `target`, the key of the entity to watch:

```ts
import { addr, key, u64 } from "@arkiv-network/sdk/attr";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
```

A **block** is Arkiv's unit of time: one every 2 seconds, so 30 blocks = 1 minute, 1,800 blocks = 1 hour and 43,200 blocks = 1 day. Warning and renewal times are numbers of blocks.

## What every subscription has

| Part                               | Value                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `project` attribute                | `"prometheus"`                                                                                                    |
| `kind` attribute                   | `"subscription"`                                                                                                  |
| `trigger` attribute                | `"expiring"`, `"expired"`, `"changed"`, `"new_match"` or `"keep"`                                                 |
| `max_per_day` attribute (optional) | `u64`, 1 to 100 alerts per UTC day. Default 20. Renewals don't count.                                             |
| Payload                            | JSON `{ "v": 1, "label": "…" }`. The label is shown in every alert and can't be empty. `new_match` adds `search`. |
| `contentType`                      | `"application/json"`                                                                                              |
| `expires`                          | How long the subscription runs. The web app offers 1, 7 or 30 days.                                               |

## Required attributes per trigger

| Trigger     | `target_key` (`key`) | `lead_blocks` (`u64`) | `keep_blocks` (`u64`) | `target_owner` (`addr`) | `search` (in the payload) |
| ----------- | -------------------- | --------------------- | --------------------- | ----------------------- | ------------------------- |
| `expiring`  | required             | required              |                       |                         |                           |
| `expired`   | required             |                       |                       |                         |                           |
| `changed`   | required             |                       |                       |                         |                           |
| `keep`      | required             | required              | required              |                         |                           |
| `new_match` |                      |                       |                       | optional                | required                  |

The bounds:

- `lead_blocks`: 30 to 43,200 (1 minute to 1 day).
- `keep_blocks`: greater than `lead_blocks`, at least 1,800 (1 hour), at most 1,296,000 (30 days).

Wrap each attribute in its type: `u64(...)` for numbers, `key(...)` for `target_key`, `addr(...)` for `target_owner`. A bare number is stored as `i32` and a bare bigint as `u256`, and workers reject both. See [Limits](./limits.md) for every number workers enforce.

## `expiring`: warn before it expires

Fires once the target is `lead_blocks` from its expiry. If the target is then renewed, you get a new warning before the new expiry. If the target already has less time left than `lead_blocks`, the warning comes right away.

```ts
const { entityKey } = await wallet.createEntity({
  attributes: {
    project: "prometheus",
    kind: "subscription",
    trigger: "expiring",
    target_key: key(target),
    lead_blocks: u64(1800), // 1 hour before expiry
  },
  payload: jsonToPayload({ v: 1, label: "Acme canary: 1 h warning" }),
  contentType: "application/json",
  expires: ExpirationTime.fromDays(7),
});
```

The receipt's event is `warned`.

## `expired`: tell me once it's gone

Fires when the target reaches its expiry without being renewed. The receipt's event is `expired`, and the alert says "Not renewed by block X", where X is the target's expiry block.

A deletion isn't an expiry: use `changed` to hear about deletions. The target may already be gone when you subscribe. If it expired within the last day, the alert comes right away.

```ts
const { entityKey } = await wallet.createEntity({
  attributes: {
    project: "prometheus",
    kind: "subscription",
    trigger: "expired",
    target_key: key(target),
  },
  payload: jsonToPayload({ v: 1, label: "Acme canary expired" }),
  contentType: "application/json",
  expires: ExpirationTime.fromDays(7),
});
```

## `changed`: edits, new owner, deletion

Fires when the target is edited (receipt event `patched`), changes owner (`owner_changed`) or is deleted (`deleted`). Several changes of one kind in the same block make one receipt.

```ts
const { entityKey } = await wallet.createEntity({
  attributes: {
    project: "prometheus",
    kind: "subscription",
    trigger: "changed",
    target_key: key(target),
  },
  payload: jsonToPayload({ v: 1, label: "Price list changes" }),
  contentType: "application/json",
  expires: ExpirationTime.fromDays(30),
});
```

## `keep`: renew it before it expires

When the target is `lead_blocks` from its expiry, a worker renews it: it sets the new expiry to the current expiry plus `keep_blocks`, and writes a `kept` receipt in the same transaction. The worker pays the fee.

A worker skips the renewal, and writes a `keep_skipped` receipt with the reason, when:

| Reason               | Meaning                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_permissionless` | The target wasn't created with `permissionlessExtension: true`, so only its owner may renew it.                                                                                                                                                |
| `deny_listed`        | The target's `kind` or `project` contains canary, heartbeat, liveness, deadman, keepalive or watchdog (any case, with or without a separator), or the target is a Prometheus entity. Their expiry is the signal, so Prometheus never hides it. |
| `already_extended`   | Someone already renewed it past this point.                                                                                                                                                                                                    |
| `already_expired`    | It expired before the worker could act.                                                                                                                                                                                                        |
| `budget`             | This worker has made its 200 renewals for the UTC day. The other worker can still act.                                                                                                                                                         |

If Arkiv refuses the renewal for any other reason, the receipt is `keep_failed`, with Arkiv's reason in its note.

```ts
const { entityKey } = await wallet.createEntity({
  attributes: {
    project: "prometheus",
    kind: "subscription",
    trigger: "keep",
    target_key: key(target),
    lead_blocks: u64(300), // renew 10 minutes before expiry
    keep_blocks: u64(43_200), // add 1 day each time
  },
  payload: jsonToPayload({ v: 1, label: "Keep incident archive" }),
  contentType: "application/json",
  expires: ExpirationTime.fromDays(30),
});
```

Renewals stop when the subscription ends.

## `new_match`: new entities that match a search

Fires when a new entity is created that matches your search. The receipt's event is `matched`, and its subject is the new entity. It sees new entities only: an entity edited into a match later isn't reported. Entities created by worker A or worker B are never matched.

`new_match` has no `target_key`. Add `target_owner` to match only entities created by one address. Each new entity is checked against at most 50 `new_match` subscriptions, oldest first.

```ts
const search = {
  and: [
    { eq: ["project", { str: "rakt-relay" }] },
    { eq: ["kind", { str: "blood_request" }] },
    { gte: ["urgency", { u64: 4 }] },
    { startsWith: ["geo", "IN-KA"] },
  ],
};

const { entityKey } = await wallet.createEntity({
  attributes: {
    project: "prometheus",
    kind: "subscription",
    trigger: "new_match",
    target_owner: addr(publisher), // optional
  },
  payload: jsonToPayload({
    v: 1,
    label: "Urgent requests in Karnataka",
    search,
  }),
  contentType: "application/json",
  expires: ExpirationTime.fromDays(7),
});
```

### The search format

The search is a JSON tree, never a query string, so text inside a value can't change the query.

- Every node is an object with exactly one key.
- `and` and `or` take a non-empty list of nodes. `not` takes one node.
- `eq`, `gt`, `gte`, `lt` and `lte` take `[name, value]`.
- `startsWith` takes `[name, "prefix"]`. The prefix is always a string.
- Every other value names its type: `{ "str": "…" }`, `{ "u64": 4 }`, `{ "i32": -1 }`, `{ "addr": "0x…" }`, `{ "key": "0x…" }`, `{ "bytes32": "0x…" }` or `{ "bool": true }`. A bare `4` is rejected, because it would be read as `i32` and never match a `u64` attribute.
- A `u64` too big for a JavaScript number goes in as a string: `{ "u64": "9007199254740993" }`.
- `ne`, `exists` and `hasType` aren't allowed.
- At most 8 conditions, and at most 3 levels counting the conditions: `and` → `or` → `eq` is the deepest allowed.

The web app's search builder writes the same shape. It ANDs the attributes you tick on an example entity:

```json
{
  "and": [
    { "eq": ["kind", { "str": "blood_request" }] },
    { "gte": ["urgency", { "u64": "4" }] },
    { "startsWith": ["geo", "IN-KA"] }
  ]
}
```

## Renew a subscription

```ts
await wallet.extendEntity({
  entityKey: subscriptionKey,
  expires: ExpirationTime.fromDays(30),
});
```

A renewal sets a new expiry counted from now. It doesn't add to the time left, and Arkiv rejects one that wouldn't move the expiry later. So renewing a subscription that has 6 days left "for 1 day" fails.

Only the subscription's owner can renew it, unless you created it with `flags: { permissionlessExtension: true }`. Then anyone may renew it. The web app calls this a **public monitor**. Workers see a renewal as soon as it lands.

## Cancel a subscription

```ts
await wallet.deleteEntity({ entityKey: subscriptionKey });
```

Workers stop serving it at once. Its receipts stay readable for their 30 days, and the deletion is publicly logged.

## Check before you sign

Workers don't tell you when they reject a subscription. They skip it and move on, so a mistake means alerts that never come. Check first, in one of three ways.

### In your code

The workers' rules live in one function, `decodeSubscription`, in the [repo](https://github.com/VanshChitransh/Prometheus) (MIT). Copy `shared/schema.ts`, `shared/subscription.ts`, `shared/searchAst.ts` and `shared/arkiv.ts` into your project, for example into `prometheus/`. They import each other with `.ts` extensions, as the repo does, and need `@arkiv-network/sdk` and `viem`. To type-check them, set `allowImportingTsExtensions` with `noEmit` in your `tsconfig.json`. To run them as they are, use Node 22.18 or later, which strips the types itself.

Describe the subscription the way a worker will read it back, then decode it:

```ts
import { stringToHex, zeroHash } from "viem";
import { decodeSubscription } from "./prometheus/subscription.ts";

const me = wallet.account.address;
const draft = {
  key: zeroHash, // unknown until created
  creator: me,
  owner: me,
  createdAt: 0n,
  expiresAt: 0n,
  flags: { readonly: false, permissionlessExtension: false },
  // As read back: u64 values are bigints; keys and addresses are hex strings.
  attributes: {
    project: "prometheus",
    kind: "subscription",
    trigger: "expiring",
    target_key: target,
    lead_blocks: 1800n,
  },
  payload: stringToHex(
    JSON.stringify({ v: 1, label: "Acme canary: 1 h warning" }),
  ),
};

const result = decodeSubscription(draft);
if (!result.ok) throw new Error(`Workers would reject this: ${result.reason}`);
```

Two more checks need the network. `shared/arkiv.ts` has free reads for both:

```ts
import { freeCount, rawGetEntity } from "./prometheus/arkiv.ts";

// `reader` is a public client: createPublicClient({ chain: tiramisu, transport: http() })
if (!(await rawGetEntity(reader, target)))
  throw new Error("No live entity has that key"); // skip this check for `expired`

const live = await freeCount(
  reader,
  `project = str('prometheus') AND kind = str('subscription') AND $creator = addr(${me})`,
);
if (live >= 20)
  throw new Error("Workers serve only your oldest 20 subscriptions");
```

The draft check can't see the types you pass to `createEntity`. It confirms the values; you still have to wrap them in `u64(...)`, `key(...)` and `addr(...)`.

### In the web app

Enter the same values in the form at `<site>/new`. It runs `decodeSubscription` as you type and shows the workers' reason in plain words. You don't have to sign anything. For `new_match`, the form builds the search from an example entity rather than from your JSON.

### After you sign

Open `<site>/s/<subscriptionKey>`. If workers reject the subscription, the page says "This isn't a valid Prometheus subscription:" followed by the reason. Cancel it, fix it and create it again.

### Rejection reasons

| Reason                                                               | Fix                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `not a prometheus subscription`                                      | Set `project` to `"prometheus"` and `kind` to `"subscription"`.                                    |
| `trigger must be one of expiring, expired, changed, new_match, keep` | Use one of those five.                                                                             |
| `target_key (a 32-byte entity key) is required for <trigger>`        | Add `target_key: key(...)` with a 66-character `0x` key.                                           |
| `lead_blocks is required for <trigger>` (or `keep_blocks`)           | Add the attribute. See the table above.                                                            |
| `lead_blocks must be a u64` (or `keep_blocks`, `max_per_day`)        | Wrap the number in `u64(...)`.                                                                     |
| `lead_blocks must be 30–43,200 (1 minute to 1 day)`                  | Pick a warning time in range.                                                                      |
| `keep_blocks must be greater than lead_blocks`                       | Each renewal must add more than the renew-before time.                                             |
| `keep_blocks must be at least 1,800 (1 hour)`                        | Add at least 1 hour per renewal.                                                                   |
| `keep_blocks can be at most 30 days of blocks`                       | Add at most 1,296,000 blocks per renewal.                                                          |
| `max_per_day must be 1–100`                                          | Pick a cap in range, or leave it out for the default of 20.                                        |
| `target_owner must be an address`                                    | Use `addr(...)` with a 20-byte `0x` address.                                                       |
| `payload must be JSON`                                               | Use `jsonToPayload({ ... })`.                                                                      |
| `payload version must be v: 1`                                       | Add `v: 1` to the payload.                                                                         |
| `label is required`                                                  | Add a non-empty `label`.                                                                           |
| `label must be one line of at most 80 characters`                    | Keep the label to one line of 80 characters or fewer.                                              |
| `search: …`, or an SDK error about an attribute name or value        | Fix the search. The message names the rule it broke, for example `search: more than 8 conditions`. |

Workers also drop a subscription whose target doesn't exist (except `expired`), and every subscription past a wallet's oldest 20.

## The same thing with the SDK

`npm i prometheus-arkiv` builds these entities, runs every check above before signing, and returns the Telegram link. See [The Prometheus SDK](./sdk.md).

## Next

- [Triggers](./triggers.md): when each trigger fires, and its edge cases.
- [Data contract](./data-contract.md): every attribute of `subscription`, `receipt` and `worker`.
- [Receipts](./receipts.md): how to read and verify what workers did.
