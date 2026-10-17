// Telegram commands (LLD §6.3). /start <payload> is the web app's deep link. A follow always links
// ctx.chat.id, the sender's own chat, never anything taken from the payload. Private chats only, so
// one member can't sign a whole group up for DMs.
// Replies never ask the user to sign or connect a wallet: a bot message that does is a phishing tell.
// Replies are plain text: labels are user-written, and Markdown/HTML parsing would let them break it.

import type { PublicArkivClient } from "@arkiv-network/sdk";
import { Bot } from "grammy";
import type { Hex } from "viem";
import { rawGetEntity } from "../shared/arkiv.ts";
import { decodeKey } from "../shared/deeplink.ts";
import { decodeSubscription } from "../shared/subscription.ts";
import type { Db } from "./db.ts";

const short = (key: string) => `${key.slice(0, 10)}…`;

// Not started here: the entrypoint (T3.4) owns long polling and shutdown.
export function createBot(token: string, db: Db, client: PublicArkivClient) {
  const bot = new Bot(token);
  const dm = bot.chatType("private");

  // The label of a live prometheus subscription; null if it expired, never existed, or isn't one.
  // Uses the free arkiv_getEntity, so a /start costs no query quota.
  const labelOf = async (key: Hex) => {
    const e = await rawGetEntity(client, key);
    const d = e && decodeSubscription(e);
    return d && d.ok ? d.sub.label : null;
  };

  dm.command("start", async (ctx) => {
    const payload = ctx.match.trim();
    if (!payload)
      return ctx.reply(
        'Hi! Create a subscription on the Prometheus web app, then tap "Follow in Telegram" to get its alerts here.',
      );
    const key = decodeKey(payload);
    if (!key)
      return ctx.reply(
        "That link looks broken. Open it again from the web app.",
      );
    const label = await labelOf(key);
    if (label === null)
      return ctx.reply(
        "No live Prometheus subscription found for that link. It may have expired.",
      );
    db.follow(ctx.chat.id, key);
    await ctx.reply(
      `✅ Following "${label}". I'll message you when it fires.\n/list shows everything you follow.`,
    );
  });

  dm.command("list", async (ctx) => {
    const keys = db.listFollows(ctx.chat.id);
    if (!keys.length) return ctx.reply("You're not following anything yet.");
    // ponytail: one lookup per follow, all at once; batch them if a chat ever follows hundreds.
    const labels = await Promise.all(keys.map((k) => labelOf(k as Hex)));
    const lines = keys.map(
      (k, i) => `${i + 1}. ${labels[i] ?? "(expired)"} · ${short(k)}`,
    );
    await ctx.reply(`${lines.join("\n")}\n\nStop one with /stop <number>.`);
  });

  dm.command("stop", async (ctx) => {
    const keys = db.listFollows(ctx.chat.id);
    const n = Number(ctx.match.trim());
    if (!Number.isInteger(n) || n < 1 || n > keys.length)
      return ctx.reply("Use /stop with a number from /list.");
    const key = keys[n - 1]!;
    db.unfollow(ctx.chat.id, key);
    await ctx.reply(`Stopped following ${short(key)}.`);
  });

  // Without a handler grammY stops polling on the first error. Log it and keep serving.
  bot.catch(async (err) => {
    console.error("bot:", err.error);
    await err.ctx
      .reply("Something went wrong. Please try again.")
      .catch(() => {});
  });

  return bot;
}
