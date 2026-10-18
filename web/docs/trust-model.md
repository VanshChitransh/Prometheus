---
title: Trust model
description: What you have to trust when you use Prometheus, what you don't, and the limits we know about.
status: live
---

Prometheus keeps as little as possible off chain, so you have to trust as little as possible. This page lists where your data lives, what each part can and can't do, what happens if the Prometheus team disappears, and the limits we know about.

## Where your data lives

| Data                                           | Where                                                      | Who writes it        | Public? |
| ---------------------------------------------- | ---------------------------------------------------------- | -------------------- | ------- |
| Subscriptions                                  | Arkiv                                                      | your wallet          | yes     |
| Receipts                                       | Arkiv                                                      | worker A or worker B | yes     |
| Worker heartbeats                              | Arkiv                                                      | worker A or worker B | yes     |
| Which Telegram chats follow which subscription | the relay's SQLite file                                    | the relay            | no      |
| Which triggers were already sent as DMs        | the relay's SQLite file                                    | the relay            | no      |
| Free test GLM top-ups                          | the relay's SQLite file                                    | the relay            | no      |
| Newsletter emails                              | the relay's SQLite file                                    | the relay            | no      |
| Questions you ask the docs assistant           | sent to OpenRouter to answer; the relay doesn't store them | you                  | no      |

The relay's database holds four tables:

- **Follows:** a Telegram chat id and the subscription key it follows.
- **Delivered:** the trigger ids already sent as DMs, so no trigger is sent twice. Rows older than 30 days are deleted.
- **Sponsors:** if you took the free 0.02 GLM top-up, your Telegram user id, your wallet address, the amount and the transaction.
- **Newsletter:** the email address, if you signed up for the newsletter.

Telegram chat ids are personal data, so they never go on chain, not even hashed. Workers keep nothing personal: their disk holds a checkpoint, unsent receipts and the key of their heartbeat entity.

### Your subscription is public

Everything in a subscription can be read by anyone: your wallet address, the entity you watch, the trigger and the label. **Don't put personal data in a subscription label.**

## What you trust, and what you don't

| Part               | You trust it to                                                                    | It can't                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arkiv              | store entities, expire them on time, record who signed what                        | –                                                                                                                                                        |
| Your wallet        | sign your subscriptions                                                            | –                                                                                                                                                        |
| Worker A, worker B | act on time and write a receipt for each action                                    | change your subscription, rewrite a receipt, or renew an entity whose owner didn't allow it                                                              |
| The relay          | send a DM to every chat that follows your subscription                             | write receipts that count, or hide receipts from the status page                                                                                         |
| The site           | list the right workers in `TRUSTED_WORKERS`, and forward Arkiv's answers unaltered | sign for you if you use MetaMask. With the built-in browser or Telegram wallet, the site's code holds your key, so you trust the deploy not to misuse it |

Why those "can't"s hold:

- **Your subscription is signed by your wallet.** Arkiv records your address as its `$creator`. A worker can't create a subscription in your name.
- **Receipts are read-only.** Receipts can't be rewritten; deletion is publicly logged.
- **Renewal needs the owner's permission.** Arkiv lets someone other than the owner renew an entity only if it was created with `permissionlessExtension`.
- **The status page reads Arkiv itself.** Your browser fetches your subscription and its receipts from Arkiv through the site's `/api/rpc` proxy (falling back to the public RPC), with no relay and no worker in between.
- **A DM is a pointer.** Every DM links to its receipt on the explorer, so you can check it against Arkiv.

## The trusted worker list

Anyone can create an entity with `kind = receipt`, and copy a real receipt's `trigger_id`. So Prometheus never trusts a receipt's attributes. It trusts its `$creator`: the wallet that signed it, which Arkiv records and no one can fake.

`TRUSTED_WORKERS` is the list of worker addresses that count:

| Worker   | Address                                      |
| -------- | -------------------------------------------- |
| Worker A | `0x6a693Fd642c1F8F5E78321C2722208A3791eE79B` |
| Worker B | `0xa70C8245582d173b04cAe453E9fF6D17a6e58294` |

- **Workers** count only receipts from this list when they check "did someone already act?" and when they count today's alerts. A lookalike receipt can't make them skip your alert or use up your daily cap.
- **The relay** sends DMs only for receipts from this list.
- **The web app** shows only receipts from this list. It's set when the site is built, and the Activity page shows each worker's address so you can check it.

A new worker's receipts are public on Arkiv from the start. For a relay or site to count them, its operator adds that worker's address to its list.

## The walk-away test

What if the Prometheus team disappeared tomorrow?

Your subscriptions aren't in our database. They're public entities on Arkiv, signed by your wallet. The code is MIT-licensed at [github.com/VanshChitransh/Prometheus](https://github.com/VanshChitransh/Prometheus). Anyone can run a worker and a relay from it. A new worker finds every subscription with the same query ours uses and serves them: no export, no migration.

What you'd redo:

- **Follow again in Telegram.** Follows live only in the old relay's database, so you'd follow your subscriptions in the new relay's bot.
- **Use a site that trusts the new workers.** Its `TRUSTED_WORKERS` must list the new workers' addresses.

Receipts already written stay readable on Arkiv until they expire. Subscriptions still end at the end of their term. Renew them yourself, or anyone can if you ticked "anyone can renew".

## Honest limits

- **The relay is the one central piece.** If it's down, Telegram alerts stop. Receipts are still written and the status page still works, and anyone can run another relay.
- **Arkiv's block production is centralised today.** So we claim Prometheus can be served without us, not that it's unstoppable.
- **Canary detection is a guess by name.** Nothing on chain marks an entity as a canary, so `keep` refuses targets whose `kind` or `project` looks like one. Your real protection is to create a canary without `permissionlessExtension`. See [Triggers](./triggers.md).
- **Calls that cost nothing in testing could be repriced.** Workers rely on free entity reads and free filtered counts (measured 16 Oct). The design still works with paid calls under an access key.
- **Each trigger is sent as a DM at most once.** The relay marks a trigger as delivered before its DMs go out, so a relay crash at that moment loses them. A DM that keeps failing is dropped after about 8.5 minutes of retries. The receipt stays on Arkiv either way.
- **Gap checks cover `expired` only.** The Activity page lists `expired` subscriptions whose target is gone with no receipt. There's no such check for the other triggers.
- **No block hash in the trigger id.** A reorg could let an old receipt hide a real trigger. Tiramisu has a single block producer, so reorgs aren't expected.

## Next

- [Receipts](./receipts.md): every field, and how to query receipts yourself
- [Workers and failover](./workers-and-failover.md): how the two workers cover for each other
- [Run a worker](./run-a-worker.md): run your own worker from the MIT code
- [Data contract](./data-contract.md): every entity and query Prometheus uses on Arkiv
