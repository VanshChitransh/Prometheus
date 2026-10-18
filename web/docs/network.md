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

The faucet needs a browser wallet sign-in and a CAPTCHA, and allows one claim per wallet per cooldown window (shown on the page). It can fund a wallet that only exists as a key on a server: sign in with any browser wallet, paste the server wallet's address into **Send to** (it defaults to the signed-in wallet), and solve the CAPTCHA. See "Fund the wallet" in [Run a worker](./run-a-worker.md).

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

An Arkiv access key raises your query quota. Send it as the `X-API-KEY` header over HTTP. Without one, calls use the anonymous quota. Arkiv's WebSocket accepts the key in the URL path (`wss://…/<key>`). Prometheus doesn't use that, because viem prints the URL, key included, in its error messages, so its live stream uses the anonymous quota.

```ts
http(url, {
  fetchOptions: { headers: { "X-API-KEY": process.env.ARKIV_ACCESS_KEY! } },
});
```

Never ship an access key to a browser.

### What calls cost

- `arkiv_query` costs 100 units: 1% of the anonymous budget (10,000 units per IP per window). An access key's monthly quota is far larger. The SDK's `getEntity()` uses it too.
- The raw methods `arkiv_getEntity` and `arkiv_getEntityCount` returned no `arkiv-cost` header when measured on 16 Oct 2026, so Prometheus treats them as free. See "Calling the free methods" in the [data contract](./data-contract.md).
- `eth_getLogs` refuses ranges over 100,000 blocks, and responses over 20,000 logs ("max results 20000, retry with the range …"). Both come back as error `-32602`.

### Entity events

Arkiv writes a log for every entity change, from the address `0x4400000000000000000000000000000000000044`: `EntityCreated`, `EntityPatched`, `ExpiryExtended`, `OwnershipTransferred` and `EntityDeleted`. An entity that expires emits no event. That is why Prometheus watches expiry blocks itself.

### Explorer links

| Page        | Pattern                                                  |
| ----------- | -------------------------------------------------------- |
| Entity      | `https://tiramisu.explorer.arkiv.network/entity/<key>`   |
| Address     | `https://tiramisu.explorer.arkiv.network/address/<addr>` |
| Transaction | `https://tiramisu.explorer.arkiv.network/tx/<hash>`      |

## The Prometheus deployment

| Part           | Value                                                                                | Notes                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Worker A       | `0x6a693Fd642c1F8F5E78321C2722208A3791eE79B`                                         | New York. Delay 0: acts first.                                                                                      |
| Worker B       | `0xa70C8245582d173b04cAe453E9fF6D17a6e58294`                                         | San Francisco. Waits 15 blocks (30 seconds), then acts only if no trusted receipt exists.                           |
| Sponsor wallet | `0x64E80982DEEfe1296CfD6483A30Fd4a46EbA7C22`                                         | Sends free GLM to new users. Creates no entities in normal operation (three test subscriptions from 18 Oct remain). |
| Relay          | `https://134-122-19-189.sslip.io`                                                    | Telegram delivery and the HTTP API below. Runs on the same host as worker A.                                        |
| Telegram bot   | [@prometheus_arkiv_bot](https://t.me/prometheus_arkiv_bot)                           | Delivers alerts as DMs.                                                                                             |
| Source         | [github.com/VanshChitransh/Prometheus](https://github.com/VanshChitransh/Prometheus) | MIT license.                                                                                                        |

To trust the same workers as the live relay and web app, use:

```bash
TRUSTED_WORKERS=0x6a693Fd642c1F8F5E78321C2722208A3791eE79B,0xa70C8245582d173b04cAe453E9fF6D17a6e58294
```

## Relay HTTP API

Base URL: `https://134-122-19-189.sslip.io`. Every response is JSON, except a `POST /ask` answer, which streams as `text/event-stream`. Any origin may call it (CORS `*`, methods `GET` and `POST`, header `content-type`); no cookies are used.

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

| Check                                                                 | Status | `error`                                                                                                             |
| --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| Body is at most 8,192 bytes                                           | 413    | "Request too large."                                                                                                |
| Body is JSON                                                          | 400    | "Send JSON."                                                                                                        |
| Body has a string `address` and `initData`                            | 400    | "Send { address, initData }."                                                                                       |
| `initData` is signed by Telegram and at most 60 seconds in the future | 401    | "Open this from the Prometheus Telegram bot."                                                                       |
| `initData` is at most 1 hour old                                      | 401    | "This Telegram session is over an hour old. Close Prometheus and open it again from the bot."                       |
| `address` is a valid address                                          | 400    | "That isn't a valid address."                                                                                       |
| Neither this Telegram user nor this address was sponsored before      | 409    | "You've already been sponsored. Need GLM? Use the faucet."                                                          |
| Less than 1 GLM sent in the last 24 hours, counting this one          | 429    | "Today's free GLM is used up. Try the faucet."                                                                      |
| The wallet holds less than 0.01 GLM                                   | 409    | "This wallet already has GLM."                                                                                      |
| The transfer was sent                                                 | 503    | "Couldn't send GLM right now. Try again later. Need GLM? Use the faucet." Your claim is released, so you can retry. |

The answers that mention the faucet also carry `"faucet": "https://hub.arkiv.network/faucet"` in the body.

The web app only offers free GLM when it was built with the relay's URL (`RELAY_PUBLIC_URL`). Otherwise it links to the faucet.

### POST /ask

The docs assistant. Send the conversation so far, ending with the reader's question:

```json
{ "messages": [{ "role": "user", "content": "How do I renew an entity?" }] }
```

The answer streams back as `text/event-stream`: one `data: {"t": "<text>"}` event per piece of text, then `data: [DONE]`. If the model fails after the stream starts, the last event is `data: {"error": "The assistant failed. Try again."}`.

| Check                                                                                                                                   | Status | `error`                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| The relay has an `OPENROUTER_API_KEY`                                                                                                   | 503    | "The docs assistant is off."                                            |
| Body is at most 65,536 bytes                                                                                                            | 413    | "Request too large."                                                    |
| Body is JSON                                                                                                                            | 400    | "Send JSON."                                                            |
| `messages` is a list of 1 to 40 turns, each with a role (`user` or `assistant`) and text, ending with a question under 1,000 characters | 400    | The rule that failed, for example "End with a question."                |
| At most 10 questions from your IP in the last 10 minutes                                                                                | 429    | "Too many questions. Try again in a few minutes."                       |
| The shared daily cap (`ASK_DAILY_CAP`, default 45 per UTC day) isn't reached                                                            | 429    | "The docs assistant is out of questions for today. Try again tomorrow." |

### POST /subscribe

Adds an email address to the Prometheus newsletter. It's kept in the relay's database, never on Arkiv.

```json
{ "email": "you@example.com" }
```

The answer is `{ "ok": true }` for a new address and for one already on the list, so nobody can check who signed up. Refusals: `429` "Too many tries. Try again in a few minutes." (more than 5 tries from one IP in 10 minutes), `400` "That doesn't look like an email address." and `503` "Sign-ups are closed for now." (the list is full).

### Other answers

`500` with "Something went wrong. Try again." for an unexpected error, `400` with "Bad request." for a malformed URL, `404` with "not found" for any other path, and `204` for a CORS preflight (`OPTIONS`).

## Telegram bot

[@prometheus_arkiv_bot](https://t.me/prometheus_arkiv_bot) works in private chats only, so one member can't sign a whole group up for alerts. It never asks you to sign anything or connect a wallet. A bot message that does is phishing.

| Command            | What it does                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/start <payload>` | Follows a subscription. The web app opens this link for you: "Get alerts in Telegram" after you sign, and "Follow in Telegram" on a status page. |
| `/start`           | Explains how to get started: create a subscription on the web app, then tap "Follow in Telegram".                                                |
| `/list`            | Lists what you follow, numbered, with each subscription's label. An expired one shows "(expired)".                                               |
| `/stop <number>`   | Stops following the subscription with that number in `/list`.                                                                                    |

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
