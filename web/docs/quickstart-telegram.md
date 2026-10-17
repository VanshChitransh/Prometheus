---
title: "Quickstart: Telegram"
description: Get your first Prometheus alert in Telegram, with no code and nothing to install.
status: live
---

This page takes you from opening the bot to your first alert. You'll create a wallet inside Telegram, point Prometheus at an Arkiv entity, and follow the subscription so alerts arrive as Telegram messages.

## What you need

- Telegram on your phone or computer.
- The key of the Arkiv entity you want to watch. Arkiv is a database where every entry, called an **entity**, has an expiry date. An entity's **key** is its address: `0x` followed by 64 hex characters. You don't need to own the entity. If you don't have a key yet, the app can pick a live example for you.

## 1. Open the bot

Open [@prometheus_arkiv_bot](https://t.me/prometheus_arkiv_bot) and tap **Start**.

Then tap **Open Prometheus**, the button next to the message field. It opens the Prometheus **Mini App**: the Prometheus web app, running inside Telegram.

## 2. Create your wallet

A **wallet** is a key that signs things on Arkiv. Your subscription is signed by your wallet, so it's yours.

1. Tap **Create wallet** at the top of the Mini App.
2. Tap your new address at the top to open the wallet menu.
3. Tap **Get free GLM to start**.

Telegram stores the wallet's key on your device. On iPhone and Android it uses Telegram's secure storage (the iOS Keychain or the Android Keystore). On Telegram Desktop and Web it uses Telegram's storage on that device. The key never leaves your device, and the wallet menu has **Export key** if you want a copy.

**GLM** is the testnet token that pays the small fee for each signed action. The relay sends 0.02 GLM to a new wallet once per Telegram account, and only to a wallet holding less than 0.01 GLM. If you see "Today's free GLM is used up. Try the faucet.", get free GLM from the [faucet](https://hub.arkiv.network/faucet) instead.

## 3. Choose what to watch

1. Paste the entity key into **Paste an entity key, 0x…** on the home screen. To use a live example instead, tap **Try a live example**.
2. Tap **Watch it**.
3. Under **What should happen**, pick one:
   - **Warn me before it expires**
   - **Tell me when it has expired**
   - **Tell me when it changes** (edits, a new owner, or deletion)
   - **Keep it alive** (Prometheus renews it before it expires)
   - **Tell me about new matching records**
4. Under **Timing**, set **Warn me this long before** (from 1 minute to 1 day) and **The subscription runs for** (1, 7 or 30 days).
5. Under **Details**, write a **Label**. It's how you'll recognise the alert.

The form checks your choices against the workers' own rules as you type. When everything is right, it says **Workers will accept this subscription.** If it says the subscription ends before the entity expires, choose a longer term: a subscription that has ended sends nothing.

## 4. Sign

Tap **Sign and create**. The Mini App signs with the wallet Telegram stores, so there's no extra prompt.

You'll see **Subscription created**. Your subscription is now an entity on Arkiv, owned by your wallet, and workers pick it up within a block.

## 5. Follow it in Telegram

Signing creates the subscription. Following it tells the bot to send you its alerts.

1. Tap **Get alerts in Telegram**.
2. Telegram opens the bot chat. Tap **Start** if Telegram asks.

The bot replies:

```text
✅ Following "Acme canary". I'll message you when it fires.
/list shows everything you follow.
```

You can follow any live subscription, not just your own. Every subscription's status page has a **Follow in Telegram** button.

## What an alert looks like

Each alert names what happened and links to the entity and to its receipt on the Arkiv explorer. A **receipt** is the public record a **worker** (one of the two Prometheus programs that watch Arkiv) writes each time it acts. Receipts can't be rewritten; deletion is publicly logged.

A warning before expiry:

```text
🟠 EXPIRING SOON · Acme canary
Block 1234567.

Target: https://tiramisu.explorer.arkiv.network/entity/0x…
Receipt: https://tiramisu.explorer.arkiv.network/entity/0x…
Tx: https://tiramisu.explorer.arkiv.network/tx/0x…
```

The block is the one where the warning became due: the entity's expiry block minus your warning time.

When the entity has expired, the second line names the block it wasn't renewed by. The same links follow.

```text
🔴 EXPIRED · Acme canary
Not renewed by block 1234867.
```

Every headline you can get:

| Headline          | Meaning                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| 🟠 EXPIRING SOON  | The entity expires soon. Your warning time has been reached.                                                   |
| 🔴 EXPIRED        | The entity expired without being renewed.                                                                      |
| ✏️ CHANGED        | The entity was edited.                                                                                         |
| 👤 OWNER CHANGED  | The entity has a new owner.                                                                                    |
| 🗑 DELETED         | The entity was deleted.                                                                                        |
| 🆕 NEW MATCH      | A new entity matching your search was created.                                                                 |
| ✅ RENEWED        | Prometheus renewed the entity.                                                                                 |
| ⏭ RENEWAL SKIPPED | Prometheus didn't renew it. The message gives the reason, for example "deny listed" for a canary or heartbeat. |
| ⚠️ RENEWAL FAILED | Arkiv refused the renewal. The message gives the reason.                                                       |

Each subscription sends at most 20 alerts per day (UTC). Renewals don't count toward that limit.

## Manage what you follow

The bot works in private chats only.

`/list` shows everything you follow, numbered:

```text
1. Acme canary · 0x1a2b3c4d…
2. (expired) · 0x5e6f7a8b…

Stop one with /stop <number>.
```

`(expired)` means the subscription has ended or was cancelled, so it won't send alerts any more.

`/stop` with a number from `/list` stops following that one:

```text
/stop 2
Stopped following 0x5e6f7a8b…
```

Stopping only stops the messages to you. The subscription itself keeps running until it ends, or until you cancel it on the **Subscriptions** tab of the Mini App.

## Next

- [Triggers](./triggers.md): what each choice watches for, and its edge cases.
- [Receipts](./receipts.md): how to check that an alert really happened, and how late it was.
- [Limits](./limits.md): warning times, renewal sizes and other numbers workers enforce.
