---
title: Workers and failover
description: How two workers cover for each other with no coordination, how you can tell which one acted, and how a worker restarts without missing anything.
status: live
---

Prometheus runs two workers, worker A and worker B, on different hosts with different wallets. They never talk to each other. Worker B waits 30 seconds and covers anything worker A missed, using Arkiv itself to find out what A already did.

## Why two workers

One worker is a single point of failure: if its host goes down, your alerts stop. Two workers on different hosts survive one outage.

| Worker   | Host          | Address                                      | `delay_blocks`   |
| -------- | ------------- | -------------------------------------------- | ---------------- |
| Worker A | New York      | `0x6a693Fd642c1F8F5E78321C2722208A3791eE79B` | 0 (acts at once) |
| Worker B | San Francisco | `0xa70C8245582d173b04cAe453E9fF6D17a6e58294` | 15 (30 seconds)  |

`delay_blocks` is how many blocks a worker waits after a trigger before it acts. Each worker reads it from its `WORKER_DELAY_BLOCKS` setting.

## No coordination

There are no locks, no leader election and no shared database. Both workers run the same code, read the same subscriptions from Arkiv and compute the same triggers. The only thing B needs to know is "did A already act?", and the answer is on Arkiv: A's receipt.

### The trigger id

For that check to work, both workers must name a trigger the same way. The **trigger id** is a hash of four fields:

```ts
triggerId = keccak256(encodePacked(subscription, subject, event, triggerBlock));
```

Same subscription, same subject, same event, same trigger block: same id, on every worker. Each receipt stores it as `trigger_id`, so "has anyone acted on this trigger?" is one free count on Arkiv. For a `keep` trigger the event is `keep`, so every outcome of one keep shares an id.

The block hash isn't part of the id. Tiramisu has a single block producer, so reorgs aren't expected.

## How worker B covers for worker A

Each worker runs these steps for every trigger:

1. **Claim it in memory.** The expiry check runs on every block while a condition holds, so without a claim, B's 15-block wait would let the same trigger through about 15 times.
2. **Wait** until the newest block reaches `trigger_block + delay_blocks`. Worker A doesn't wait. Worker B waits 15 blocks (30 seconds).
3. **Check Arkiv.** Count receipts with this `trigger_id` created by a trusted worker. This is a free call.
4. **Act or step back.** If the count is above 0, someone already acted: write nothing. Otherwise, act and write the receipt.

If A is down, B finds no receipt at step 3 and writes it itself. Your alert arrives about 30 seconds late, and the receipt's lateness shows it.

The daily alert cap is per subscription, not per worker. A trigger the other worker handled still uses one of your `max_per_day` slots, so two workers can't send you twice your cap.

### When both workers write

Sometimes both workers write a receipt for the same trigger. That happens when A's receipt hasn't landed by the time B checks: for example, A's batch was slow, or the trigger block was already more than 15 blocks in the past when both saw it (after a catch-up, or a warning time longer than the time left).

It's harmless:

- **One DM.** The relay records each `trigger_id` it has delivered and sends one message per trigger, whichever worker's receipt arrives first.
- **One renewal.** For `keep`, both workers compute the same new expiry block. The second renewal sets the same expiry, which the node treats as a no-op: it costs gas but doesn't extend twice.

After a failed send, a worker waits at least 10 seconds before it checks again and resends, so a receipt that did go out can be indexed first. That's inside B's 30-second window.

## The heartbeat entity

Each worker proves it's alive with a `worker` entity on Arkiv.

| Attribute      | Type | Value                                     |
| -------------- | ---- | ----------------------------------------- |
| `project`      | str  | `prometheus`                              |
| `kind`         | str  | `worker`                                  |
| `version`      | str  | `0.1.0`                                   |
| `operator`     | str  | a label only; trust comes from `$creator` |
| `delay_blocks` | u64  | `0` for A, `15` for B                     |

- **Lifetime:** 30 minutes. Every 10 minutes, the worker renews it to 30 minutes from now.
- **Why that works:** expiry is the health check. Three renewals fit in one lifetime, so the entity survives two missed renewals. If the worker stops, it stops renewing, and Arkiv deletes the entity within 30 minutes. This needs no extra code.
- **How it's read:** a free count of `worker` entities whose `$creator` is that worker's address. The relay and the Coverage page both use it.
- **On restart:** the worker reuses its saved entity and renews it at once. If the entity lapsed while the worker was down, it creates a new one.

Because of the 30-minute lifetime, a worker that just stopped can still show as live for up to 30 minutes.

## What the Coverage page shows

Open `<site>/activity`. Your browser reads the last 24 hours (43,200 blocks) of trusted receipts from Arkiv and groups them by `trigger_id`. Every number on the page comes from those receipts, so you can check it yourself.

Each trigger gets one status:

| Status          | Receipts it has      | What it means                                   |
| --------------- | -------------------- | ----------------------------------------------- |
| normal          | worker A's only      | A acted, and B stepped back                     |
| covered by B    | worker B's only      | A missed it, and B covered: a failover          |
| delivered twice | one from each worker | both acted; harmless, and the relay sent one DM |

`keeper_low_funds` and `keep_skipped` with note `budget` aren't counted as deliveries. They describe one worker, not a trigger.

The page also shows:

- **Each worker:** live or offline (from its heartbeat), how many triggers it delivered, how many only it delivered, its typical (median) and largest lateness, and "Low on funds" if it wrote a `keeper_low_funds` receipt.
- **A headline** when a worker is down, such as "A offline · 3 covered by B", or "B offline · no failover backup".
- **Gaps:** `expired` subscriptions whose target is gone with no trusted `expired` receipt. A target that expired in the last minute can show here until its receipt lands.

## Startup and replay

A worker keeps its working state in memory and rebuilds it from Arkiv on every start. Only three things live on its disk: the checkpoint, the unsent receipts and the key of its heartbeat entity. A worker refuses to start if its own address isn't in `TRUSTED_WORKERS`, because then its own receipts wouldn't count in step 3 and every restart would write them again.

On start, a worker:

1. **Loads its checkpoint:** the last block it fully handled. On first boot there's none, so it starts 1,800 blocks (1 hour) back.
2. **Discovers subscriptions** with a paged query, then reads and checks each one.
3. **Builds the expiry schedule** with one free read per watched entity. For an entity that's gone, it searches the last 43,200 blocks (1 day) of that entity's logs for its real expiry block. That way `expired` gets the same trigger id the other worker uses. Subscriptions other than `expired` whose target isn't live are dropped.
4. **Resumes unsent receipts** from its file, skipping any that already landed on Arkiv.
5. **Rebuilds today's alert counts** from trusted receipts on Arkiv, so a restart doesn't reset `max_per_day`.
6. **Connects and catches up:** subscribes to the live stream first, waits for its first block, replays every event from the checkpoint to the newest block, then goes live. See [How it works](./how-it-works.md).
7. **Starts its heartbeat and an hourly re-sync.** The re-sync discovers subscriptions again and re-reads targets. Arkiv sends no event when a subscription expires, so this is how a worker drops expired ones and fixes drifted expiries.

The worker doesn't rebuild its list of triggers already handled. After a restart, a repeat trigger costs one free count, finds its receipt and is marked done.

On a graceful stop, a worker gives itself up to 5 seconds to send its last receipts and save its checkpoint. A hard stop is still safe: the next start resends whatever the file holds.

**Known limit:** if a worker is down for more than 1 day, a target that expired in that time gets no `expired` receipt from it.

## Next

- [Receipts](./receipts.md): the fields the trigger id and lateness come from
- [Trust model](./trust-model.md): why only trusted workers' receipts count
- [Run a worker](./run-a-worker.md): run your own worker from the same code
