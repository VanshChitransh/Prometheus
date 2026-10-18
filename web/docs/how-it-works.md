---
title: How it works
description: What happens between signing a subscription and getting an alert, in three steps: watch, act, prove.
status: live
---

Prometheus does three things for every subscription: it watches Arkiv, acts when something happens, and proves it acted. This page walks through each step, then follows one alert from start to finish.

## The problem it solves

On Arkiv, every entity (one stored record) has an expiry block. When that block arrives, Arkiv deletes the entity and fires no event. If nobody is watching, nobody finds out.

A **subscription** is an entity you create, signed by your wallet, that says "watch this entity for me". A **worker** is a program that reads subscriptions and watches the chain. Prometheus runs two of them, worker A and worker B, on different hosts. A **receipt** is an entity a worker writes every time it acts. The **relay** turns receipts into Telegram messages.

A **block** is Arkiv's unit of time: one every 2 seconds, so 30 blocks = 1 minute and 43,200 blocks = 1 day.

```text
                 Arkiv (one block every 2 s)
                  |                      ^
   live events    |                      |  receipt entity
   + new blocks   v                      |
        +------------------+   +------------------+
        | Worker A         |   | Worker B         |
        | acts at once     |   | waits 15 blocks  |
        +------------------+   +------------------+
          WATCH: expiry schedule, stall timer, replay
          ACT:   alert (write a receipt) or renew (keep alive)
          PROVE: receipt with trigger and done blocks
                                         |
                    +--------------------+-------------------+
                    v                                        v
          relay -> Telegram DM                status page <site>/s/<key>
```

## Watch

Each worker keeps one WebSocket open to Arkiv. Over it, the worker receives two streams:

- **Entity events**: every create, change, renewal, ownership transfer and delete on the chain.
- **New blocks**: one "head" (the newest block number) every 2 seconds.

### The expiry schedule

Arkiv sends no event when an entity expires, so the worker keeps its own list. The **expiry schedule** is an in-memory map from each watched entity to its expiry block. The worker fills it at startup with one free read per watched entity, then keeps it current from events: a renewal moves the expiry, a delete removes the entry.

On every new block, the worker checks the schedule against the block number. This costs no queries. When a watched entity's expiry block arrives, the worker makes one free read to confirm the entity is really gone. If it's still there, the worker missed a renewal and updates the schedule instead.

### The stall timer

A socket can go quiet without closing, so a worker could look alive while hearing nothing. Each new block resets a 15-second timer, about 7 missed blocks. If the timer runs out, the worker drops both streams, subscribes again and catches up. A socket error starts the same catch-up after 5 seconds.

### Replay

Catching up means asking Arkiv for every entity event since the **checkpoint**: the last block the worker fully handled, saved to a file. The worker fetches those blocks in ranges of up to 1,000, and halves the range if the node says it's too large.

The order matters. The worker subscribes to the live stream first and buffers what arrives, then replays the gap, then drains the buffer. Some events arrive twice; the worker drops repeats by transaction hash and log index. A gap would lose an alert. An overlap loses nothing.

The checkpoint moves past a block only once every event in it is handled. So a crash or restart replays from where the worker stopped, not from where it was told about.

## Act

When a subscription's condition comes true, the worker does one of two things.

- **Alert.** For `expiring`, `expired`, `changed` and `new_match`, the worker writes a receipt. The relay turns that receipt into a Telegram message. Each subscription gets at most `max_per_day` alerts per UTC day: 20 unless you set it, up to 100 (only when you build the entity yourself; see [Without the SDK](./without-the-sdk.md)).
- **Renew.** For `keep`, the worker extends the target entity's expiry. The extension and its `kept` receipt go in **one transaction**, so a `kept` receipt exists only if the renewal landed. If the worker can't or won't renew, it writes a receipt saying why. See [Triggers](./triggers.md) for every outcome.

Before acting, the worker checks that no trusted worker has already written a receipt for this trigger. That check is how two workers share the job without talking to each other. See [Workers and failover](./workers-and-failover.md).

Workers send receipts in batches: when 10 are waiting, or every 5 blocks (10 seconds), whichever comes first. Unsent receipts are saved to a file, so a restart sends them instead of losing them.

## Prove

Every receipt records two blocks:

- `trigger_block`: when the condition became true.
- `done_block`: when the worker acted.

**Lateness** is `done_block − trigger_block`. The app shows a receipt as "on time" when its lateness is 0 or 1 block. A receipt from worker B is always at least 15 blocks (30 seconds) late, because B waits that long before covering for A.

Receipts are entities on Arkiv, so anyone can read them without asking Prometheus. They live for 30 days. Receipts can't be rewritten; deletion is publicly logged. See [Receipts](./receipts.md).

## One alert, end to end

Say you want a warning 10 minutes before an entity expires. Its expiry block is 11,800, and 10 minutes is 300 blocks.

1. **You subscribe.** Your wallet creates a subscription entity with `trigger = expiring`, the entity's key as `target_key`, and `lead_blocks = 300`.
2. **Both workers pick it up.** Each sees the create event, confirms with a free count that it's a Prometheus subscription, reads it and checks its fields. Each reads the target's expiry (11,800) into its schedule.
3. **Block 11,500 arrives** (11,800 − 300). Worker A's schedule says the warning is due. A computes the trigger id, a hash that every worker computes the same way for this trigger. It counts trusted receipts with that id: 0. A queues a `warned` receipt with `trigger_block` 11,500 and `done_block` set to the block it acted in, 11,500 or the one after.
4. **The receipt lands.** Within 5 blocks, A sends it in a batch. Arkiv emits a create event for the new receipt entity.
5. **The relay delivers it.** The relay reads the receipt (a free call), checks that its creator is a trusted worker, records the trigger id as delivered, and sends a DM to everyone following your subscription. The DM links to the target and the receipt on the explorer.
6. **Block 11,515: worker B checks.** B's 15-block wait is over. It counts trusted receipts with the same trigger id: 1. B writes nothing.

If worker A had been down, B would have counted 0 at block 11,515 and written the receipt itself, 15 blocks (30 seconds) late. On the Activity page, worker B's row would count it as delivered only by B, 15 blocks late.

## Next

- [Triggers](./triggers.md): the five triggers, their attributes and every receipt they produce
- [Receipts](./receipts.md): every field on a receipt and how to find yours
- [Workers and failover](./workers-and-failover.md): how two workers cover for each other with no coordination
- [Trust model](./trust-model.md): what you trust, what you don't, and the honest limits
