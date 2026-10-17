---
title: Network
description: The endpoints, chain settings, addresses and APIs you need to connect to Arkiv and to the live Prometheus deployment.
status: live
---

Prometheus runs on Arkiv's Tiramisu testnet. This page collects everything you need to connect: the chain settings, the live workers and relay, the relay's HTTP API and the Telegram bot.

## Arkiv Tiramisu testnet

| Setting      | Value                                                 |
| ------------ | ----------------------------------------------------- |
| Network name | Tiramisu (Arkiv testnet)                              |
| Chain id     | `7738577` (hex `0x7614d1`)                            |
| HTTP RPC     | `https://rpc.tiramisu.db-chain.testnet.arkiv.network` |
| WebSocket    | `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`   |
| Explorer     | `https://tiramisu.explorer.arkiv.network`             |
| Faucet       | `https://hub.arkiv.network/faucet`                    |
| Gas token    | GLM (Golem), 18 decimals                              |
| Block time   | 2 seconds                                             |

Every lifetime on Arkiv is counted in blocks. 30 blocks are 1 minute, 1,800 blocks are 1 hour and 43,200 blocks are 1 day.

The faucet needs a browser wallet and a CAPTCHA, and allows one claim per wallet per hour. To fund a wallet that only exists as a key on a server, see "Fund the wallet" in [Run a worker](./run-a-worker.md).

### Connect from code

Prometheus uses `@arkiv-network/sdk` 0.8.1 with `viem` 2.57.7. The SDK ships the chain settings as `tiramisu`.

```ts
import { createPublicClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { http } from "viem";

const client = createPublicClient({
  chain: tiramisu,
  transport: http("https://rpc.tiramisu.db-chain.testnet.arkiv.network"),
});
```

An Arkiv access key raises your query quota. Send it as the `X-API-KEY` header over HTTP. Without one, calls use the anonymous quota. The WebSocket transport can't send headers, so live events always use the anonymous quota.

```ts
http(url, {
  fetchOptions: { headers: { "X-API-KEY": process.env.ARKIV_ACCESS_KEY! } },
});
```

Never ship an access key to a browser.

### What calls cost

- `arkiv_query` costs 100 units, about 1% of an access key's quota. The SDK's `getEntity()` uses it too.
- The raw methods `arkiv_getEntity` and `arkiv_getEntityCount` returned no `arkiv-cost` header when measured on 16 Oct 2026, so Prometheus treats them as free. See "Calling the free methods" in the [data contract](./data-contract.md).
- `eth_getLogs` refuses ranges over 100,000 blocks.

### Entity events

Arkiv writes a log for every entity change, from the address `0x4400000000000000000000000000000000000044`: `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred` and `EntityDeleted`. An entity that expires emits no event. That is why Prometheus watches expiry blocks itself.

### Explorer links

| Page        | Pattern                                                  |
| ----------- | -------------------------------------------------------- |
| Entity      | `https://tiramisu.explorer.arkiv.network/entity/<key>`   |
| Address     | `https://tiramisu.explorer.arkiv.network/address/<addr>` |
| Transaction | `https://tiramisu.explorer.arkiv.network/tx/<hash>`      |

## The Prometheus deployment

| Part           | Value                                                                                | Notes                                                                                     |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Worker A       | `0x6a693Fd642c1F8F5E78321C2722208A3791eE79B`                                         | New York. Delay 0: acts first.                                                            |
| Worker B       | `0xa70C8245582d173b04cAe453E9fF6D17a6e58294`                                         | San Francisco. Waits 15 blocks (30 seconds), then acts only if no trusted receipt exists. |
| Sponsor wallet | `0x64E80982DEEfe1296CfD6483A30Fd4a46EbA7C22`                                         | Sends free GLM to new users. Writes no entities.                                          |
| Relay          | `https://134-122-19-189.sslip.io`                                                    | Telegram delivery and the HTTP API below. Runs on the same host as worker A.              |
| Telegram bot   | [@prometheus_arkiv_bot](https://t.me/prometheus_arkiv_bot)                           | Delivers alerts as DMs.                                                                   |
| Source         | [github.com/VanshChitransh/Prometheus](https://github.com/VanshChitransh/Prometheus) | MIT license.                                                                              |

To trust the same workers as the live relay and web app, use:

```bash
TRUSTED_WORKERS=0x6a693Fd642c1F8F5E78321C2722208A3791eE79B,0xa70C8245582d173b04cAe453E9fF6D17a6e58294
```

## Relay HTTP API

Base URL: `https://134-122-19-189.sslip.io`. Every response is JSON. Any origin may call it (CORS `*`, methods `GET` and `POST`, header `content-type`); no cookies are used.

### GET /health

```bash
curl https://134-122-19-189.sslip.io/health
```

```json
{
  "ok": true,
  "workersAlive": [
    "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B",
    "0xa70C8245582d173b04cAe453E9fF6D17a6e58294"
  ]
}
```

- `ok`: the relay is up.
- `workersAlive`: the trusted workers whose `worker` entity is live, meaning each renewed it in the last 30 minutes. It is `null` if the relay couldn't reach Arkiv; the relay still reports itself as up.
- Callers share one answer for 30 seconds, because each check spends quota.

### POST /sponsor

Sends 0.02 GLM to a new user's wallet, so they can create a subscription without the faucet. It only works from inside the Telegram Mini App, the web app opened from the bot.

```json
{
  "address": "0x<your wallet address>",
  "initData": "<Telegram Mini App initData>"
}
```

`initData` is the signed string Telegram gives a Mini App about the user who opened it. The relay checks its signature with the bot's token, so it proves a real Telegram user is asking.

On success you get the transfer's hash as soon as it is sent. The relay doesn't wait for the block.

```json
{ "tx": "0x<transaction hash>" }
```

The relay runs these checks in order. The first one that fails decides the answer.

| Check                                                                                     | Status | `error`                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Body is at most 8,192 bytes                                                               | 413    | "Request too large."                                                                                             |
| Body is JSON                                                                              | 400    | "Send JSON."                                                                                                     |
| Body has a string `address` and `initData`                                                | 400    | "Send { address, initData }."                                                                                    |
| `initData` is signed by Telegram, at most 1 hour old and at most 60 seconds in the future | 401    | "Open this from the Prometheus Telegram bot."                                                                    |
| `address` is a valid address                                                              | 400    | "That isn't a valid address."                                                                                    |
| The wallet holds less than 0.01 GLM                                                       | 409    | "This wallet already has GLM."                                                                                   |
| Less than 1 GLM sent in the last 24 hours, counting this one                              | 429    | "Today's free GLM is used up. Try the faucet." The body also has `"faucet": "https://hub.arkiv.network/faucet"`. |
| This Telegram user and this address were never sponsored                                  | 409    | "You've already been sponsored."                                                                                 |
| The transfer was sent                                                                     | 503    | "Couldn't send GLM right now. Please try again." Your claim is released, so you can retry.                       |

Other answers: `500` with "Something went wrong. Try again." for an unexpected error, `400` with "Bad request." for a malformed URL, `404` with "not found" for any other path, and `204` for a CORS preflight (`OPTIONS`).

The web app only offers free GLM when it was built with the relay's URL (`RELAY_PUBLIC_URL`). Otherwise it links to the faucet.

## Telegram bot

[@prometheus_arkiv_bot](https://t.me/prometheus_arkiv_bot) works in private chats only, so one member can't sign a whole group up for alerts. It never asks you to sign anything or connect a wallet. A bot message that does is phishing.

| Command            | What it does                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `/start <payload>` | Follows a subscription. The web app's "Follow in Telegram" button opens this link for you.         |
| `/start`           | Explains how to get started: create a subscription on the web app, then tap "Follow in Telegram".  |
| `/list`            | Lists what you follow, numbered, with each subscription's label. An expired one shows "(expired)". |
| `/stop <number>`   | Stops following the subscription with that number in `/list`.                                      |

When the relay is configured with the web app's URL (`WEB_URL`), the chat also shows an "Open Prometheus" button that opens the web app inside Telegram.

### Follow links

A follow link is `https://t.me/prometheus_arkiv_bot?start=<payload>`. Telegram caps the payload at 64 characters and a hex key is 66, so the payload is the subscription key's 32 bytes as unpadded base64url: 43 characters.

```ts
const payload = Buffer.from(subscriptionKey.slice(2), "hex").toString(
  "base64url",
);
const link = `https://t.me/prometheus_arkiv_bot?start=${payload}`;
```

In a browser, use `encodeKey` from `shared/deeplink.ts`.

The relay sends one DM per follower for each receipt. If worker A and worker B both write a receipt for the same trigger, you still get one DM.

## Next

- [Run a worker](./run-a-worker.md): connect your own worker to this network.
- [Data contract](./data-contract.md): the entities and queries behind these endpoints.
- [Workers and failover](./workers-and-failover.md): how worker A and worker B share the work.
