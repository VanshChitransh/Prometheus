---
title: Limits
description: Every limit Prometheus enforces, its value in human time and blocks, why it exists, and what happens when you reach it.
status: live
---

Prometheus bounds what a subscription can ask for and how much work one wallet can cause. This page lists every limit in the code. A block comes every 2 seconds, so 30 blocks are 1 minute, 1,800 blocks are 1 hour and 43,200 blocks are 1 day.

## Subscription fields

Workers and the web form run the same checks. The form shows the reason before you sign; a worker ignores a subscription written another way that breaks a rule, and logs the same reason.

| Limit                                               | Value                                 | Blocks       | What it does                                                                              | When you reach it                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warning lead time (`lead_blocks`)                   | 1 minute to 1 day                     | 30 to 43,200 | Keeps an `expiring` warning or a `keep` renewal between 1 minute and 1 day before expiry. | Rejected: "lead_blocks must be 30–43,200 (1 minute to 1 day)".                                                                                                                                                                                       |
| Smallest renewal (`keep_blocks`)                    | 1 hour                                | 1,800        | A renewal every few blocks would burn a worker's gas for one target.                      | Rejected: "keep_blocks must be at least 1,800 (1 hour)".                                                                                                                                                                                             |
| Largest renewal (`keep_blocks`)                     | 30 days                               | 1,296,000    | Caps how far one renewal moves the expiry.                                                | Rejected: "keep_blocks can be at most 30 days of blocks".                                                                                                                                                                                            |
| Renewal must outrun the lead                        | `keep_blocks` more than `lead_blocks` |              | Otherwise the target is "about to expire" again the moment it is renewed.                 | Rejected: "keep_blocks must be greater than lead_blocks".                                                                                                                                                                                            |
| Alerts per subscription per UTC day (`max_per_day`) | default 20, from 1 to 100             |              | Stops one busy subscription from flooding your chat.                                      | Out of range: rejected, "max_per_day must be 1–100". Over the cap: see "Alerts over the daily cap" below.                                                                                                                                            |
| Subscriptions per wallet                            | 20                                    |              | Bounds how much work one wallet can create.                                               | Workers serve the wallet's oldest 20, by creation block, then key. The rest get no alerts, and the web app's "mine" page marks them "not served". If one of the 20 goes away, the next oldest is picked up at the hourly re-sync, so within an hour. |
| Search depth (`new_match`)                          | 3 levels                              |              | Keeps each search small enough to check against every new entity.                         | Rejected: "search: deeper than 3 levels".                                                                                                                                                                                                            |
| Search conditions (`new_match`)                     | 8                                     |              | As above.                                                                                 | Rejected: "search: more than 8 conditions".                                                                                                                                                                                                          |

### Alerts over the daily cap

The cap is per subscription, shared by worker A and worker B, and the day is UTC. Past it:

- No receipt is written and no DM is sent for that alert.
- A `changed` or `new_match` alert happens once, so it is dropped for good.
- An `expiring` or `expired` alert is offered again on every block while its condition holds. It fires after the next UTC midnight if the condition still holds then.
- Renewal outcomes (`kept`, `keep_skipped`, `keep_failed`, `keeper_low_funds`) never use the cap. Skipping a renewal would let the target expire.

## Worker work limits

| Limit                                            | Value            | Why                                                                                                                                                 | When you reach it                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Renewals per worker per UTC day                  | 200              | Anyone can point a `keep` subscription at any entity that allows public renewal. Without a ceiling, a few wallets could drain a worker's gas.       | The worker writes `keep_skipped` with note `budget`, once per trigger, and keeps offering the trigger. The other worker can still renew if it has budget left, and this worker tries again after UTC midnight if the target is still live. A renewal Arkiv refuses still counts, because it cost gas; one lost to a network error doesn't. |
| Keeper reserve                                   | 0.005 GLM        | Keeps GLM back for heartbeats and receipts. The code sizes it at about 200 renewals of about 25,500 gas at about 1 gwei.                            | The worker stops renewing and writes `keeper_low_funds` once per trigger. It keeps offering the trigger, so a refill still acts.                                                                                                                                                                                                           |
| `new_match` subscriptions checked per new entity | 50, oldest first | The per-wallet cap is 20, so three throwaway wallets could otherwise fill the worker's request slots with match checks and stall every other event. | For each new entity, workers check only the 50 oldest live `new_match` subscriptions that could match it. Newer ones don't fire for that entity. The worker logs a warning at most once a minute.                                                                                                                                          |

## Lifetimes

| Entity           | Lifetime                                                     | Blocks                       | Why                                                                                             | When it ends                                                                                                               |
| ---------------- | ------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Worker heartbeat | 30 minutes, renewed every 10 minutes                         | 900                          | The expiry is the health check. Renewing three times per lifetime survives two missed renewals. | If the worker stops, its entity is gone within 30 minutes, and the relay's `/health` and the web app stop listing it.      |
| Receipt          | 30 days                                                      | 1,296,000                    | A month of auditable history, then it cleans itself up.                                         | Arkiv deletes it.                                                                                                          |
| Subscription     | 1, 7 or 30 days in the web app (workers accept any lifetime) | 43,200, 302,400 or 1,296,000 | A subscription you forget about ends on its own.                                                | Workers stop serving it. Renew it from the "mine" page before then; the page only offers terms that move the expiry later. |

## Entities the keeper never renews

A `keep` subscription never renews a target that is meant to expire when its owner stops, like a dead-man switch. The worker writes `keep_skipped` with note `deny_listed` instead.

A target is skipped if its `kind` or `project` attribute contains any of these words, in any case:

- canary
- heartbeat
- liveness
- deadman
- keepalive
- watchdog

"heartbeat", "deadman" and "keepalive" also match with one character between the halves, such as `heart-beat`, `dead_man` or `keep alive`.

The keeper also never renews Prometheus's own entities (`project = "prometheus"`). Two public subscriptions renewing each other would never end.

This is a name check, because nothing on Arkiv marks an entity as a canary. Your real protection is to create such an entity without `permissionlessExtension`: then only you can renew it, and the worker writes `keep_skipped` with note `not_permissionless`.

## Relay limits

These apply to the free GLM the relay sends to new users (`POST /sponsor`, see [Network](./network.md)).

| Limit                      | Value                                                | Why                                                 | When you reach it                                                          |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| Free GLM per claim         | 0.02 GLM                                             | Enough to create a subscription without the faucet. |                                                                            |
| Claims                     | one per Telegram user and one per address            | It is free money, so every gate stops abuse.        | 409: "You've already been sponsored."                                      |
| Already funded             | 0.01 GLM or more                                     | A funded wallet doesn't need it.                    | 409: "This wallet already has GLM."                                        |
| Total per rolling 24 hours | 1 GLM, about 50 users                                | Caps what the sponsor wallet can lose to abuse.     | 429: "Today's free GLM is used up. Try the faucet.", with the faucet link. |
| Telegram sign-in age       | at most 1 hour old, at most 60 seconds in the future | A stale or forged sign-in must not work.            | 401: "Open this from the Prometheus Telegram bot."                         |
| Request body               | 8,192 bytes                                          | Nobody can stream junk into memory.                 | 413: "Request too large."                                                  |
| `/health` answer           | shared for 30 seconds                                | Each check spends quota; delivery needs that quota. | You get the cached answer.                                                 |

## Under the hood

Limits you only meet when you run a worker or relay.

| Limit                                  | Value                                                      | Why                                                                                                            | When you reach it                                                                                    |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Receipts per transaction               | 50                                                         | Keeps a backlog after an outage under the block gas limit.                                                     | The rest go in later transactions. A worker sends when it has 10 receipts queued, or every 5 blocks. |
| Catch-up on first start                | 1 hour (1,800 blocks)                                      | A new worker needs a starting point.                                                                           | Events older than that aren't replayed. Later starts resume from the saved checkpoint.               |
| `expired` look-back at startup         | 1 day (43,200 blocks)                                      | The worker finds a missing target's real expiry block with one `eth_getLogs` call over this window.            | A target that expired more than a day before the worker started gets no `expired` receipt from it.   |
| Catch-up chunk                         | 1,000 blocks per `eth_getLogs` call                        | The node refuses ranges over 100,000 blocks.                                                                   | If the node refuses a chunk, the worker halves it and retries.                                       |
| Calls in flight to the node            | 16                                                         | The measured safe level: about 49 free counts a second with no errors. An unbounded burst timed about 100 out. | Further calls wait their turn.                                                                       |
| Retries for one event                  | 10, about 4 minutes of backoff (1 second up to 30 seconds) | One permanent bug must not freeze the worker.                                                                  | The event is dropped and logged as an error.                                                         |
| Silence on the live stream             | 15 seconds without a new block, about 7 missed blocks      | Detects a socket that went quiet.                                                                              | The worker resubscribes and replays from its checkpoint.                                             |
| Telegram DM retries                    | 10 tries, about 8.5 minutes                                |                                                                                                                | The DM is dropped.                                                                                   |
| Delivered receipts the relay remembers | 30 days                                                    | Only needed while a replay could bring a receipt back.                                                         | Older ids are pruned once a day.                                                                     |

## Next

- [Data contract](./data-contract.md): the fields these limits apply to.
- [Triggers](./triggers.md): what each trigger watches for.
- [Run a worker](./run-a-worker.md): what these limits cost an operator.
