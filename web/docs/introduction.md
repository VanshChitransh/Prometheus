---
title: Introduction
description: What Prometheus is, the gap in Arkiv it fills, and which page to read next.
status: live
---

Prometheus tells you when something happens to data on Arkiv: before it expires, once it's gone, when it changes, or when a new matching entry appears. It can also renew data for you. This page explains the problem, the five things Prometheus can watch for, and where to go next.

## The expiry gap

Arkiv is a database built for Ethereum. Every entry in it is called an **entity**, and every entity has an expiry date. When that date passes, Arkiv removes the entity.

Arkiv's own documentation says what happens next:

> "An entity that reaches its expiration date fires no event."

So nothing tells you. If you run a warrant canary (a statement a company renews on schedule, so that silence is the warning), a booking or a heartbeat on Arkiv, the moment it expires is often the most important moment in your app, and it happens in silence. You only find out if you go and look.

The people who lose out are real. Several teams in this buildathon shipped a renew button that a person has to remember to press, or built their own watcher. Gig workers in India lose pay records on Nexora Ledger when nobody presses "Keep alive". VPN users miss a dead warrant canary on Lapse or Arkiv Canary unless they run cron. Traders stuck behind an exchange halt only hear about it from Door Ledger if the author's private monitor tells them.

Prometheus looks for you. Two independent programs, called **workers**, run on different hosts: worker A in New York and worker B in San Francisco. Both read every **block** (Arkiv's unit of time: one every 2 seconds) and act when something you asked about comes true. Worker A acts first; worker B waits 15 blocks (30 seconds) and acts only if A didn't.

## What you can ask for

You ask by creating a **subscription**: a small Arkiv entity, signed by your own wallet, that says what to watch and what to do. Each subscription has one **trigger**.

| Trigger     | What Prometheus does                                                                                                                                               | What you give it                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `expiring`  | Warns you a set time before the entity expires, while there's still time to renew it.                                                                              | The entity's key and a warning time, from 1 minute to 1 day.                            |
| `expired`   | Tells you once the entity has expired. The alert says it was "not renewed by block X".                                                                             | The entity's key.                                                                       |
| `changed`   | Tells you when the entity is edited, changes owner or is deleted.                                                                                                  | The entity's key.                                                                       |
| `new_match` | Tells you when a new entity is created that matches your search.                                                                                                   | A search, and optionally the address that must have created it.                         |
| `keep`      | Renews ("keeps alive") the entity before it expires. It only works if the entity's creator allowed anyone to renew it, and it never renews canaries or heartbeats. | The entity's key, how long before expiry to renew, and how much time each renewal adds. |

You don't need to own the entity you watch. An entity's **key** is its address on Arkiv: `0x` followed by 64 hex characters.

Every time a worker acts, it writes a **receipt**: another Arkiv entity that records what happened, for which subscription, the block where the condition came true and the block where the worker acted. Receipts can't be rewritten; deletion is publicly logged. They last 30 days. A separate service, the **relay**, turns receipts into Telegram messages for anyone who follows the subscription.

## Who you have to trust

- **Your subscription is yours.** Your wallet signs it, and it lives on Arkiv as a public entity you own. Workers never create subscriptions.
- **Receipts prove who acted.** The web app and the relay only believe a receipt whose creator is a known worker wallet (worker A or worker B), so a forged receipt from anyone else is ignored.
- **The relay is the one central piece.** If it's down, Telegram messages stop, but workers still write receipts and the status page still shows them.

Read [Trust model](./trust-model.md) for the full picture.

## Where to go next

| You are                                               | Start here                                                |
| ----------------------------------------------------- | --------------------------------------------------------- |
| Someone who wants alerts in Telegram, with no code    | [Quickstart: Telegram](./quickstart-telegram.md)          |
| A developer with an Arkiv app                         | [Quickstart: developers](./quickstart-developers.md)      |
| Using an AI coding agent (Claude Code, Codex, Cursor) | [Use Prometheus from an AI coding agent](./for-agents.md) |
| Someone who wants to run their own worker             | [Run a worker](./run-a-worker.md)                         |

## Next

- [How it works](./how-it-works.md): what happens between signing a subscription and getting an alert.
- [Triggers](./triggers.md): each trigger in detail, with its edge cases.
- [Limits](./limits.md): every number workers enforce.
