---
title: Arkiv never tells you when your data expires
dek: On Arkiv, an entity's expiry is often the most important moment in an app, yet nothing fires when it happens, so we built Prometheus to watch for it, act on it, and prove it did.
date: 2026-10-17
author: The Prometheus team
---

Arkiv is a database built for Ethereum. Each entry in it is called an _entity_. Data you store there is public and owned by your wallet, and every entity is stored for a set time: an hour, a week, a year. When that time runs out, the entity leaves the database's search results. Nobody has to delete it.

That expiry date is Arkiv's signature feature. It is also why we built Prometheus.

## Expiry is the moment that matters

The best Arkiv apps are built around the moment an entity expires:

- **Warrant canary.** A company renews a statement every week. If it stops renewing, the statement lapses, and that silence is the warning.
- **Booking or lease.** It ends exactly when the entity expires.
- **Heartbeat.** A server or agent renews an entity to prove it is alive. When the renewals stop, it is presumed dead.
- **Access grant.** "My doctor can see this for 30 days" ends on its own.
- **Listing or offer.** It disappears when the seller stops renewing it.

In each of these, expiry is the most important event in the app.

## Nothing fires when it happens

Arkiv's documentation states it plainly:

> "An entity that reaches its expiration date fires no event. Expiration is not an operation the engine applies, so nothing fires. To find out whether an entity is gone, query for it."

So the moment that matters most passes in silence. Arkiv's live updates report creations and changes, never expiry. Someone has to go and look.

## The evidence

Builders keep running into it:

- **Friction reports from 17 teams** named "no event on expiry" as the most-reported pain. Nine teams raised it.
- **Arkiv's ETHRome review** found that 5 teams hand-built live updates, and 9 struggled with expiry timing.
- **Arkiv's product manager**, in SDK issue #112, wrote that live updates confused "Five ETHRome teams".
- **Our own review of 26 Arkiv projects** found that 10 of 11 current entries wrote their own watching code, and 11 of 11 wrote their own expiry check. Yet 0 of 11 alert a person when something expires. Each one stops at a command-line tool and an instruction like "put it in a cron job."
- **Arkiv's own wishlist** on the Arkiv Hub, under "Nobody built this yet", asks for this: "Arkiv Triggers — Zapier for Expiring Data. A worker network that watches queries, reacts to entity expiration or state changes, executes actions, and writes signed receipts back to Arkiv."

Most developer pains on Arkiv are bugs the team is already fixing. The missing expiry signal is different. It is a deliberate design choice, so it will not be patched away.

## Why serverless apps feel it most

Many Arkiv apps have no server on purpose. A static page that reads straight from Arkiv is censorship resistant, and that is the point. But a static page only checks when someone opens it.

If a warrant canary dies at 3 a.m., nobody knows until a person happens to visit. Lapse, a current hackathon entry, names this failure in its own README: a canary gets "missed, since nobody is watching a static page for a renewal that didn't happen."

Running your own watcher costs you, too:

- **It burns the shared query budget.** Arkiv limits how often an app can ask questions for free. Apps that keep re-checking run out and freeze. Four teams hit this in their friction reports.
- **It only covers your own data.** A journalist watching a company's canary would have to run a watcher of their own.
- **Data lapses by accident.** Public evidence and community records can expire because the original owner forgot to renew them.

## How Prometheus fills the gap

Prometheus does three things: watch, act, and prove.

**Watch.** Paste the key of any entity on Arkiv, yours or someone else's, and pick what you want to know. You can get a warning before it expires, a message when it's gone, a message when it changes (an edit, a new owner, or deletion), or a message for each new entity like the one you point at. That choice is your _subscription_. Two independent workers, worker A and worker B, check Arkiv at every block. A new block arrives every 2 seconds.

**Act.** When something you asked about happens, a worker records it on Arkiv, and a relay turns that into a Telegram message. You can also ask Prometheus to keep an entity alive. A worker then renews it before it expires, but only if its creator allowed anyone to renew it. It refuses entities whose names mark them as canaries or heartbeats, because their silence is the message.

**Prove.** Every action leaves a _receipt_: a public entity on Arkiv that records what happened, when, and which worker acted. Receipts can't be rewritten; deletion is publicly logged.

```text
new block (every 2 s)
  ├─ worker A: acts at once ─────────────────────┐
  └─ worker B: waits 15 blocks, acts only if     │
               there is no receipt yet ──────────┤
                                                 ▼
                         receipt on Arkiv ─► relay ─► Telegram
```

## You don't have to trust us

- **Receipts are public.** You can verify that you were told, and when. A missed alert shows up as a missing receipt. The coverage page shows which worker delivered each alert, and any gaps.
- **Two workers, two servers.** Worker A acts at once. Worker B waits 15 blocks, about 30 seconds, then looks on Arkiv for a receipt. If there is none, B acts. If one worker stops, the other takes over within 30 seconds.
- **Your subscription is yours.** It is stored on Arkiv under your wallet, not in our database. It lasts 1, 7 or 30 days, then expires like any other entity. If we disappeared, anyone could run a worker from the open-source code and keep serving it.

There are limits. The relay is the one central piece today. If it is down, Telegram messages stop, but receipts are still written and the status page still works. Arkiv's block production is centralised today, so we claim Prometheus can keep running without us, not that it is unstoppable. And spotting a canary is a guess based on its name, because nothing on Arkiv marks an entity as one.

## Try it

Open [@prometheus_arkiv_bot](https://t.me/prometheus_arkiv_bot) in Telegram, paste an entity key, and pick an alert. Telegram creates your wallet and we cover the fee. It's free on Arkiv's testnet, with no account and no server to run.

- [Quickstart: Telegram](/docs/quickstart-telegram)
- [Introduction to Prometheus](/docs/introduction)
