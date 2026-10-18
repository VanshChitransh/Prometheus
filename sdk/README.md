# prometheus-arkiv

Watch [Arkiv](https://arkiv.network) entities from your code. Prometheus warns you before an entity expires, tells you when it has expired, changed or a new matching entity appears, or keeps it alive, and sends the alerts to Telegram.

Every entity on Arkiv has an expiry block, and when it passes, the entity is deleted without a sound. A Prometheus **subscription** is an Arkiv entity, signed by your own wallet, that tells Prometheus's workers what to watch. This package builds it, checks it against the workers' own rules, and signs it. No API key, no server of your own.

Docs and source: [github.com/VanshChitransh/Prometheus](https://github.com/VanshChitransh/Prometheus) (MIT).

## Install

```bash
npm i prometheus-arkiv @arkiv-network/sdk viem
```

The package is ESM only. `@arkiv-network/sdk` (0.8.1 or later 0.8.x) and `viem` are peer dependencies. The network is Arkiv's Tiramisu testnet. Your wallet needs a little testnet GLM for gas: get some from the [faucet](https://hub.arkiv.network/faucet).

## Quick start

```ts
import { createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Prometheus } from "prometheus-arkiv";

const wallet = createWalletClient({
  chain: tiramisu,
  transport: http(),
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
});
const prometheus = new Prometheus({ wallet });

const sub = await prometheus.watch.expiring(entityKey, {
  before: "1h",
  for: "7d",
  label: "Our canary",
});
console.log(sub.telegramUrl); // open it and tap Start to get the alert
```

`entityKey` is the key of any live Arkiv entity (`0x` + 64 hex characters). You don't need to own it.

## Before anything is signed

Workers don't tell you when they reject a subscription: they skip it, and the alert never comes. So every `watch` call checks first, the same way the Prometheus web app does, and throws a `PrometheusError` without signing if any check fails:

1. The options are valid (durations, label, `where`).
2. The workers' own decoder (`decodeSubscription`) accepts the subscription.
3. The target entity exists (not checked for `expired`: its target may already be gone).
4. For `keep`: the target can be renewed by anyone and isn't a canary or heartbeat.
5. Your wallet has fewer than 20 live subscriptions (workers serve only a wallet's oldest 20).
6. Your wallet's GLM balance isn't zero.

All of these reads are free.

npm 0.1.0 predates the workers' label rule (one line, no control characters); 0.1.1 will match.

## Durations

Every time option is a string: a whole number and a unit, `s`, `m`, `h` or `d`. For example `"30s"`, `"10m"`, `"1h"`, `"7d"`. Arkiv makes a block every 2 seconds, so a duration in seconds must be even. Anything else throws `bad_duration`.

## API

### `new Prometheus(options)`

```ts
const prometheus = new Prometheus({
  wallet, // required: an Arkiv WalletArkivClient with an account
  publicClient, // optional: for reads. Default: a Tiramisu client
  site: "https://prometheus.example", // optional: adds statusUrl to results
  botName: "prometheus_arkiv_bot", // optional: the Telegram bot
  trustedWorkers: ["0x…"], // optional: whose receipts count. Default: worker A and worker B
});
```

Every `watch` method resolves to:

```ts
{
  key: "0x…",          // the subscription key: keep it to renew, cancel or read receipts
  txHash: "0x…",
  telegramUrl: "https://t.me/prometheus_arkiv_bot?start=…", // follow it in Telegram; shareable
  statusUrl?: "https://your.site/s/0x…", // when you pass `site`
  notes: [],           // warnings that don't stop the create (see below)
}
```

`statusUrl` links from npm 0.1.0 use `/#/s/`, which still opens the page.

Every `watch` method takes `label` (required, 1 to 80 characters, shown in every alert), `for` (how long the subscription runs, default `"7d"`) and `public` (anyone may renew the subscription, default `false`).

`notes` warns about choices that are valid but probably not what you want, for example "The subscription ends before the entity expires (in ~12 d). Pass a longer `for`." A subscription that has ended sends nothing.

### `watch.expiring(target, { before, for?, label, public? })`

Warns `before` the target expires: `"1m"` to `"1d"`. If the target is then renewed, you get a new warning before the new expiry. If it already has less than `before` left, the warning comes right away.

```ts
await prometheus.watch.expiring(target, {
  before: "1h",
  for: "7d",
  label: "Our canary",
});
```

### `watch.expired(target, { for?, label, public? })`

Tells you once the target has expired without being renewed. If it expired within the last day, the alert comes right away. A deletion isn't an expiry: use `changed` for that.

```ts
await prometheus.watch.expired(target, { for: "7d", label: "Canary gone" });
```

### `watch.changed(target, { for?, label, public? })`

Tells you when the target is edited, changes owner or is deleted.

```ts
await prometheus.watch.changed(target, { for: "30d", label: "Price list" });
```

### `watch.keep(target, { before, extendBy, for?, label, public? })`

Renews the target `before` it expires, adding `extendBy` each time (`"1h"` to `"30d"`, and more than `before`). A worker pays the fee. The target must have been created with `permissionlessExtension: true`, and its `kind` or `project` must not look like a canary or heartbeat: otherwise every renewal would be skipped, so this throws `keep_blocked`.

```ts
await prometheus.watch.keep(target, {
  before: "10m",
  extendBy: "1d",
  for: "30d",
  label: "Incident archive",
});
```

### `watch.newMatch({ where, createdBy?, for?, label, public? })`

Tells you when a new entity is created whose attributes equal everything in `where`. Strings match as `str`, a bigint as `u64`, `0x` + 40 hex as `addr` and `0x` + 64 hex as `key`. A plain number throws: write `4n`. `createdBy` limits it to entities created by one address. At most 8 conditions.

```ts
await prometheus.watch.newMatch({
  where: { kind: "booking", city: "Pune", seats: 4n },
  createdBy: "0x…",
  for: "7d",
  label: "New Pune bookings",
});
```

In v0.1, `where` is equality only. For ranges (`gte`, `lt`…), `startsWith`, `or` and `not`, write the search tree yourself: see [Without the SDK](https://github.com/VanshChitransh/Prometheus/blob/main/web/docs/without-the-sdk.md).

### `check.*`

The same five methods as `watch`, with the same arguments. Runs every check, signs nothing.

```ts
const r = await prometheus.check.keep(target, {
  before: "2h",
  extendBy: "1h",
  label: "x",
});
// { ok: false, code: "bad_extend_by", reason: "`extendBy` must add more time per renewal than `before`." }
// or { ok: true, notes: [] }
```

### `renew(subscriptionKey, duration)`

Runs the subscription for `duration` from now. A renewal sets a new expiry; it doesn't add to the time left. So renewing a subscription with 6 days left "for 1 day" throws `renew_too_short`. Only its owner can renew it, unless it was created with `public: true`.

```ts
const { txHash, expiresAt } = await prometheus.renew(sub.key, "30d");
```

### `cancel(subscriptionKey)`

Deletes the subscription. Workers stop at once; its receipts stay readable for their 30 days.

```ts
const { txHash } = await prometheus.cancel(sub.key);
```

### `get(subscriptionKey)`

The subscription as workers decode it, or `null` once it has ended or been cancelled. Throws `rejected` if workers would reject it.

```ts
const s = await prometheus.get(sub.key);
// { key, creator, trigger: "expiring", label: "Our canary", leadBlocks: 1800n, expiresAt, … }
```

### `receipts(subscriptionKey)`

Every time a worker acts, it writes a **receipt** entity on Arkiv. This returns the receipts written by the trusted workers, newest first. Anyone can write an entity that looks like a receipt, so only these count.

```ts
for (const r of await prometheus.receipts(sub.key))
  console.log(r.event, r.subject, r.triggerBlock, r.doneBlock);
// "warned", "0x…", 123456n, 123458n
```

## Errors

Every check throws a `PrometheusError` with a `code` and a sentence you can show a user. Network failures throw the underlying error; the free Arkiv reads (`arkiv_getEntity`, `arkiv_getEntityCount`) wrap it in an `RpcError` whose `cause` is the original.

```ts
import { PrometheusError } from "prometheus-arkiv";

try {
  await prometheus.watch.expiring(target, { before: "2d", label: "x" });
} catch (e) {
  if (e instanceof PrometheusError && e.code === "bad_before")
    console.log(e.message);
  // "Choose `before` between 1 minute and 1 day."
}
```

| Code                     | Meaning                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `bad_duration`           | A duration isn't like `"30s"`, `"10m"`, `"1h"` or `"7d"`.                   |
| `bad_label`              | The label is empty or longer than 80 characters.                            |
| `bad_target`             | The target isn't `0x` + 64 hex characters.                                  |
| `bad_before`             | `before` isn't between 1 minute and 1 day.                                  |
| `bad_extend_by`          | `extendBy` is under 1 hour, over 30 days, or not more than `before`.        |
| `bad_where`              | `where` is empty, has a value that isn't a string or bigint, or is too big. |
| `bad_created_by`         | `createdBy` isn't an address.                                               |
| `bad_key`                | A subscription key isn't `0x` + 64 hex characters.                          |
| `no_account`             | The wallet client has no account.                                           |
| `target_not_found`       | No live entity has the target key.                                          |
| `keep_blocked`           | Workers would skip every renewal of this target.                            |
| `too_many_subscriptions` | The wallet already has 20 live subscriptions.                               |
| `no_funds`               | The wallet has no GLM for the fee.                                          |
| `not_found`              | No live subscription has that key.                                          |
| `not_owner`              | Only the subscription's owner can do that.                                  |
| `renew_too_short`        | The subscription already runs past that.                                    |
| `rejected`               | Workers would reject it for another reason, given in the message.           |

## Limits

`LIMITS` holds what workers accept, in the options' units:

```ts
import { LIMITS, TRIGGERS } from "prometheus-arkiv";

LIMITS.before; // { min: "1m", max: "1d" }
LIMITS.extendBy; // { min: "1h", max: "30d" }
LIMITS.labelMaxLength; // 80
LIMITS.subscriptionsPerWallet; // 20
LIMITS.whereMaxConditions; // 8
TRIGGERS; // ["expiring", "expired", "changed", "new_match", "keep"]: Subscription["trigger"]
```

Durations are converted to blocks at one block every 2 seconds, so they're approximate if the chain runs fast or slow. Workers send at most 20 alerts per subscription per UTC day. See [Limits](https://github.com/VanshChitransh/Prometheus/blob/main/web/docs/limits.md) for every number.

## In a browser

Pass a wallet client built from the user's browser wallet. The user signs; your page never sees a key.

```ts
import { createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { custom } from "viem";
import { Prometheus } from "prometheus-arkiv";

const ethereum = (window as any).ethereum;
const [account] = await ethereum.request({ method: "eth_requestAccounts" });
const wallet = createWalletClient({
  chain: tiramisu,
  transport: custom(ethereum),
  account,
});
await wallet.addChain({ chain: tiramisu }); // adds Tiramisu if missing; MetaMask then asks to switch to it
const prometheus = new Prometheus({ wallet });
```

## Links

- [The Prometheus SDK](https://github.com/VanshChitransh/Prometheus/blob/main/web/docs/sdk.md): this API, with every edge case
- [Triggers](https://github.com/VanshChitransh/Prometheus/blob/main/web/docs/triggers.md): when each one fires, and its edge cases
- [Receipts](https://github.com/VanshChitransh/Prometheus/blob/main/web/docs/receipts.md): how to read and verify what workers did
- [Source](https://github.com/VanshChitransh/Prometheus) (MIT)
