---
title: Run a worker
description: How to set up, fund, start and check your own Prometheus worker, and how its receipts get counted.
status: live
---

Anyone can run a Prometheus worker. It reads subscriptions from Arkiv, watches every block, writes a receipt for each action and renews entities for `keep` subscriptions. This page takes you from a fresh clone to a healthy worker.

## What you need

- **Node 24 or newer.** Node runs the TypeScript files directly, so there is no build step.
- **A wallet key for this worker only.** Don't reuse one that another running process uses: two processes on one key race for nonces (the per-wallet transaction counter) and stall each other.
- **Some GLM** in that wallet, to pay gas.
- **An Arkiv access key, optional.** Without one, the worker uses the anonymous quota.
- **A folder that survives restarts** for the worker's `state/` files.
- **Docker, optional,** if you'd rather run a container.

## 1. Get the code

```bash
git clone https://github.com/VanshChitransh/Prometheus.git
cd Prometheus
npm ci
```

`npm ci` installs the exact versions in `package-lock.json`. On a server that only runs the worker, `npm ci --omit=dev` skips the web app's tools.

## 2. Configure

`npm run worker` loads `.env`, then `.env.worker-a` on top; a value in the second file wins. Every `.env*` file except `.env.example` is gitignored.

### Make a key without printing it

Run this before you write `.env.worker-a`. It creates a random key and writes it straight into the file, so the key never shows on screen:

```bash
node -e 'const k = "0x" + require("crypto").randomBytes(32).toString("hex"); require("fs").appendFileSync(".env.worker-a", `WORKER_PRIVATE_KEY=${k}\n`)'
chmod 600 .env.worker-a
```

Then print only the worker's address:

```bash
node --env-file=.env.worker-a -e 'import("viem/accounts").then((m) => console.log(m.privateKeyToAddress(process.env.WORKER_PRIVATE_KEY)))'
```

### Write the two files

`.env`, shared by every process on the machine:

```bash
ARKIV_HTTP=https://rpc.tiramisu.db-chain.testnet.arkiv.network
ARKIV_WS=wss://rpc.tiramisu.db-chain.testnet.arkiv.network
TRUSTED_WORKERS=0x6a693Fd642c1F8F5E78321C2722208A3791eE79B,0xa70C8245582d173b04cAe453E9fF6D17a6e58294,<your worker address>
```

`.env.worker-a`, below the key line the command above wrote:

```bash
ARKIV_ACCESS_KEY=
WORKER_DELAY_BLOCKS=20
```

See "Primary or backup" below for how to pick the delay.

### Every variable the worker reads

| Variable              | File            | Required | Rule                                                                        | What it does                                                                                                                                                           |
| --------------------- | --------------- | -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARKIV_HTTP`          | `.env`          | yes      | an `https://` URL                                                           | the RPC endpoint for reads and writes                                                                                                                                  |
| `ARKIV_WS`            | `.env`          | yes      | a `wss://` URL                                                              | the live stream of blocks and entity events                                                                                                                            |
| `TRUSTED_WORKERS`     | `.env`          | yes      | comma-separated `0x` addresses; a mixed-case one must have a valid checksum | the workers whose receipts count. It must include this worker's own address. List the primary (delay 0) first: the web app names workers A, B and so on in this order. |
| `ARKIV_ACCESS_KEY`    | `.env.worker-a` | no       | empty means the anonymous quota                                             | sent as the `X-API-KEY` header on HTTP calls                                                                                                                           |
| `WORKER_PRIVATE_KEY`  | `.env.worker-a` | yes      | `0x` and 64 hex characters                                                  | the wallet that signs receipts, renewals and the heartbeat                                                                                                             |
| `WORKER_DELAY_BLOCKS` | `.env.worker-a` | yes      | a whole number of blocks; there is no default in the code                   | how long the worker waits before acting                                                                                                                                |

The worker checks every variable when it starts and lists every problem at once. The messages never include the values, because some are secrets:

```text
Invalid config (worker):
- WORKER_PRIVATE_KEY is missing
- TRUSTED_WORKERS must be comma-separated 0x addresses (a mixed-case one must have a valid checksum)
```

It also refuses to start if `TRUSTED_WORKERS` leaves out its own address, with `TRUSTED_WORKERS must include this worker's address 0x…`. Without it, the worker's own receipts wouldn't count in its "already done?" check, and every restart would write them again.

`.env.example` lists more variables. A worker doesn't read them:

| Variable                                                    | Used by                          | Default                           |
| ----------------------------------------------------------- | -------------------------------- | --------------------------------- |
| `SPONSOR_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`                 | relay                            | none, both required for the relay |
| `RELAY_DB_PATH`                                             | relay                            | `state/relay.db`                  |
| `PORT`                                                      | relay                            | `8080`                            |
| `WEB_URL`                                                   | relay and the seed script        | none                              |
| `DEMO_PUBLISHER_PRIVATE_KEY`, `DEMO_SUBSCRIBER_PRIVATE_KEY` | the seed script (`npm run seed`) | none                              |
| `VITE_BOT_NAME`, `RELAY_PUBLIC_URL`                         | the web app build                | none                              |

## 3. Fund the wallet

The faucet at `https://hub.arkiv.network/faucet` needs a browser wallet sign-in and a CAPTCHA, and allows one claim per wallet per hour. There is no command-line or API route, so it can't fund a key that only lives in a file.

The workaround: claim with a browser wallet such as MetaMask, then send GLM from it to the worker's address. You can send from the wallet's own screen, or with Foundry's `cast`:

```bash
cast send --interactive --rpc-url https://rpc.tiramisu.db-chain.testnet.arkiv.network <your worker address> --value <amount>ether
```

`--interactive` asks for the sending key at a prompt, so it stays out of your shell history. GLM has 18 decimals, so `1ether` means 1 GLM. A few GLM is enough to start. If the balance drops below 0.005 GLM, the worker stops renewing and writes a `keeper_low_funds` receipt instead, so you can see it on the Coverage page.

Check the balance:

```bash
cast balance --ether --rpc-url https://rpc.tiramisu.db-chain.testnet.arkiv.network <your worker address>
```

## 4. Start the worker

```bash
npm run worker
```

To run a second worker on the same machine, put its key and delay in `.env.worker-b` and run `npm run worker:b`. Each wallet keeps its own state files, so the two don't collide.

### With Docker

The `Dockerfile` builds one image for the worker and the relay. It copies only `shared/`, `worker/` and `relay/`, so your `.env*` files and `state/` never end up in the image. Its default command starts the relay, so pass the worker's command.

A container doesn't read `.env`. Put all six worker variables in `.env.worker-a`, and write values without quotes: Docker's `--env-file` keeps quotes as part of the value.

```bash
docker build -t prometheus .
docker run -d --name prometheus-worker --restart unless-stopped --stop-timeout 10 \
  --env-file .env.worker-a \
  -v "$PWD/state/worker:/app/state" \
  prometheus node worker/index.ts
docker logs -f prometheus-worker
```

`compose.yaml` runs the full stack on one host: worker A, the relay and Caddy for HTTPS. Use it if you also run your own relay. It needs `.env.worker-a` and `.env.relay`, each with the full set of variables for its process, and `RELAY_HOST` in `.env`. Then run `docker compose up -d --build`.

## 5. Check it is healthy

A healthy start logs these lines. `<…>` stands for values from your run.

```text
[subs] <n> subscriptions, <n> rejected
[startup] <n> targets: <n> live, <n> expired while away, <n> gone with no expiry in the last day; <n> subscriptions dropped (target not live)
[startup] <n> receipts so far today (since block <block>)
[stream] replayed <n> blocks (<from> → <head>), live
[heartbeat] worker entity live at <time>: <entity key> (owner <your address>)
```

- `[subs]`: the worker found every valid subscription. Rejected ones are grouped by reason in brackets.
- `[startup] … targets`: one free read per watched entity. Subscriptions whose target is gone are dropped, except `expired` ones.
- `[startup] … receipts so far today`: today's alert counts, rebuilt from receipts on Arkiv, so a restart doesn't reset `max_per_day`.
- `[stream] … live`: the worker caught up from its checkpoint and now follows new blocks. On a first start it replays the last hour, about 1,800 blocks.
- `[heartbeat] worker entity live`: the first start created your `worker` entity. After a restart you see `[heartbeat] reusing worker entity <key>` instead.

The `[stream]` and `[heartbeat]` lines can appear in either order. Later you also see:

- `[receipts] resumed <n> unsent receipts (<n> already on chain)` after a restart that left receipts unsent.
- `[events] subscription <key> added (<trigger>)` when someone creates a subscription.
- `[resync] <n> subscriptions (+<added> −<dropped>, <n> kept from live events)` once an hour.

Confirm your heartbeat from outside. This count returns `1` while your worker runs:

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_getEntityCount","params":[{"query":"project = str('prometheus') AND kind = str('worker') AND $creator = addr(<your worker address>)"}]}
EOF
```

### Lines that need attention

| Line                                                                      | Meaning                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[stream] no head for 15s: stall → resubscribe`                           | The socket went quiet. The worker reconnects and replays the gap on its own. If it repeats, check that the WebSocket URL is reachable.                                                                          |
| `[stream] <what>: <message>; catch-up in 5s`                              | A socket error. The worker replays from its checkpoint 5 seconds later.                                                                                                                                         |
| `[heartbeat] beat failed (<n> in a row)`                                  | A heartbeat renewal failed. From the third in a row it is logged as an error. After 30 minutes of failures your `worker` entity expires and you show as offline; the worker creates a new one when it recovers. |
| `[receipts] flush of <n> failed; retry in <s>s`                           | Sending receipts failed. They stay on disk and are sent again.                                                                                                                                                  |
| `[receipts] chain refused receipt <id>, dropped: <reason>`                | Arkiv refused one receipt. That is a bug: report it with the reason.                                                                                                                                            |
| `[match] <n> new_match subscriptions; evaluating the oldest 50 per event` | The per-entity cap on `new_match` checks is in effect. See [Limits](./limits.md).                                                                                                                               |

## Primary or backup

`WORKER_DELAY_BLOCKS` is how many blocks the worker waits after a trigger before it checks whether a trusted worker already wrote the receipt.

- **0, a primary.** It acts at once. Worker A runs with 0.
- **15, a backup.** It waits 30 seconds and acts only if no trusted receipt exists by then. Worker B runs with 15. If the primary is down, users get an alert 30 seconds late instead of none.
- **Two workers with the same delay** both act on every trigger. The relay still sends one DM, but each worker pays gas.
- **Next to the live worker A and worker B**, list all three in `TRUSTED_WORKERS` and use a delay of at least 20. Worker B acts at 15 and sends its queued receipts every 5 blocks, so this leaves room for its receipt to land. You then act only when both have missed a trigger.

The `operator` label on your `worker` entity is `team-a` when the delay is 0 and `team-b` otherwise. It is a label only.

## Files the worker keeps

In `state/` under the working directory (`/app/state` in Docker), one set per wallet:

| File                        | Holds                                                           |
| --------------------------- | --------------------------------------------------------------- |
| `checkpoint-<address>.json` | the last block fully handled. The next start replays from here. |
| `pending-<address>.json`    | receipts not yet on Arkiv. The next start sends them.           |
| `worker-key-<address>.json` | the key of your `worker` entity, reused after a restart         |

Keep `state/` across restarts and redeploys. If you lose it, unsent receipts are lost, only the last hour is replayed, and the worker creates a second `worker` entity while the old one runs out its 30 minutes.

## Stopping

Press Ctrl-C or send `SIGTERM`. The worker stops taking work, tries one last send of queued receipts and finishes writing its files, within 5 seconds. Exiting mid-write is still safe: the next start sends whatever the pending file holds.

Never run two copies with the same key. They race for nonces.

## How your work becomes visible

Your receipts are public on Arkiv the moment they land. Anyone can list them with `$creator = addr(<your worker address>)`, or open your address on the explorer at `https://tiramisu.explorer.arkiv.network/address/<your worker address>`.

But trust comes from `$creator`. The Prometheus relay and website count only receipts from addresses in their `TRUSTED_WORKERS` list. Until your address is on it, the relay sends no DMs for your receipts and the coverage page doesn't show them. To be counted, either:

- **Ask the operator to add your address** to `TRUSTED_WORKERS` on the relay, the web app build and the other workers. The workers need it too, so their "already done?" check sees your receipts and they don't repeat your work.
- **Run your own relay and website** with a `TRUSTED_WORKERS` list that includes you. `compose.yaml` runs a worker and a relay together.

A renewal is different: when your worker renews a `keep` target, the new expiry is on Arkiv for everyone, trusted or not.

## What it costs

- **Receipts:** gas for each one. Workers send up to 50 per transaction.
- **Renewals:** the keeper estimates about 25,500 gas at about 1 gwei per renewal. At most 200 per worker per UTC day. Below 0.005 GLM the worker stops renewing and writes `keeper_low_funds`.
- **Heartbeat:** one renewal of your `worker` entity every 10 minutes, 144 a day.
- **Queries:** one paged `arkiv_query` at startup and once an hour, 100 units per page. Everything the worker does per block uses free calls.

## Keep keys safe

- Never print, paste or commit `WORKER_PRIVATE_KEY` or `ARKIV_ACCESS_KEY`. Keep `.env*` files gitignored and `chmod 600`.
- Never bake them into an image. Pass them at run time with `--env-file`.
- A worker key only needs a little GLM. Top it up as needed rather than holding a large balance.

## Next

- [Workers and failover](./workers-and-failover.md): how worker A and worker B share triggers.
- [Trust model](./trust-model.md): why only trusted `$creator` receipts count.
- [Limits](./limits.md): the budgets and caps your worker enforces.
