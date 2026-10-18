---
title: "Quickstart: developers"
description: Install the SDK, watch an Arkiv entity from your code, follow it in Telegram and read its receipts.
status: live
---

This takes about five minutes. You install `prometheus-arkiv`, create one subscription signed by your own wallet, follow it in Telegram and see the receipt a worker writes when it fires.

## What you need

- **Node 22.18 or later** (it runs `.ts` files directly), or `npx tsx` on older Node, or any bundler for a browser app.
- **A wallet with a little testnet GLM** (the fee token on Arkiv's Tiramisu testnet). Get some free from the [faucet](https://hub.arkiv.network/faucet).
- **The key of an entity to watch.** Any live Arkiv entity works, yours or someone else's: `0x` followed by 64 hex characters. You can copy one from the [explorer](https://tiramisu.explorer.arkiv.network).

## 1. Install

```bash
npm i prometheus-arkiv @arkiv-network/sdk viem
```

## 2. Watch an entity

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

const sub = await prometheus.watch.expiring("0x…entity key…", {
  before: "1h", // warn me an hour before it expires
  for: "7d", // the subscription runs for a week
  label: "Our canary", // shown in every alert
});

console.log(sub.key); // the subscription: keep it to renew, cancel or read receipts
console.log(sub.telegramUrl); // open it to get the alert in Telegram
```

Run it with your key in the environment, never in the code: `PRIVATE_KEY=0x… node watch.ts` on Node 22.18 or later, or `PRIVATE_KEY=0x… npx tsx watch.ts`.

Before signing, the SDK checks everything the workers check. If something is wrong (a typo in the key, a warning time over a day, a wallet with no GLM), it throws a `PrometheusError` with a plain sentence and signs nothing.

## 3. Follow it in Telegram

Open `sub.telegramUrl` and tap **Start**. The bot replies `✅ Following "Our canary"`. Anyone with the link can follow, so you can share it with your users.

When the warning time comes, the message looks like this:

```text
🟠 EXPIRING SOON · Our canary
Block 703243.

Status: <site>/s/0x…
Target: https://tiramisu.explorer.arkiv.network/entity/0x…
Receipt: https://tiramisu.explorer.arkiv.network/entity/0x…
Tx: https://tiramisu.explorer.arkiv.network/tx/0x…
```

## 4. See the receipt

Every time a worker acts, it writes a **receipt** on Arkiv: what happened, when the condition came true and when it acted. Receipts can't be rewritten; deletion is publicly logged.

```ts
for (const r of await prometheus.receipts(sub.key))
  console.log(r.event, r.triggerBlock, r.doneBlock); // "warned", 703243n, 703243n
```

You can also open the status page, `<site>/s/<subscription key>`, which reads the same receipts straight from Arkiv.

## In a browser app

Let your users sign with their own wallet. Build the wallet client from it instead of a private key:

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

## Next

- [The Prometheus SDK](./sdk.md): every method (`expired`, `changed`, `keep`, `newMatch`, `renew`, `cancel`), with error codes.
- [Triggers](./triggers.md): when each trigger fires, and its edge cases.
- [Without the SDK](./without-the-sdk.md): the same subscription as a plain `createEntity` call.
