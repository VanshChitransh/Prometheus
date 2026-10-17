// Receipt delivery (LLD §6.4): every trusted receipt becomes one DM per follower. Node only.
// stream → trust check → recipients → dedupe on trigger_id → a rate-limited send queue.
// Dedupe is a table (relay/db.ts), so receipts from both workers, or a restart and its replay,
// never send a second DM.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EntityEvent, PublicArkivClient } from "@arkiv-network/sdk";
import type { Hex } from "viem";
import { rawGetEntity } from "../shared/arkiv.ts";
import {
  parseReceipt,
  type Receipt as ParsedReceipt,
} from "../shared/receipt.ts";
import { saveCheckpoint, startBlock } from "../shared/replay.ts";
import type { Event } from "../shared/schema.ts";
import { startStream, type StreamOptions } from "../shared/stream.ts";
import { decodeSubscription } from "../shared/subscription.ts";
import type { Db } from "./db.ts";

const EXPLORER = "https://tiramisu.explorer.arkiv.network"; // routes: /entity/<key>, /tx/<hash>
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const SEND_TRIES = 10; // with the backoff below: ~8.5 min of transient failures before a drop
const SEND_BACKOFF_MAX_MS = 5 * 60_000;

// The relay adds the creating transaction, which only the stream event knows.
export type Receipt = ParsedReceipt & { tx?: Hex };

const HEADLINE: Record<Event, string> = {
  warned: "🟠 EXPIRING SOON",
  expired: "🔴 EXPIRED",
  patched: "✏️ CHANGED",
  owner_changed: "👤 OWNER CHANGED",
  deleted: "🗑 DELETED",
  matched: "🆕 NEW MATCH",
  kept: "✅ RENEWED",
  keep_skipped: "⏭ RENEWAL SKIPPED",
  keep_failed: "⚠️ RENEWAL FAILED",
  keeper_low_funds: "⚠️ KEEPER LOW ON FUNDS",
};

// Plain text: labels are user-written, so Markdown/HTML parsing would let them break the message.
// Canary wording is "not renewed by block X", never "compromised" (arkiv/schema.md).
export function formatReceipt(r: Receipt, label: string): string {
  const reason = r.note?.replaceAll("_", " ");
  const detail =
    r.event === "expired"
      ? `Not renewed by block ${r.triggerBlock}.`
      : (r.event === "keep_skipped" || r.event === "keep_failed") && reason
        ? `Reason: ${reason}. Block ${r.triggerBlock}.`
        : `Block ${r.triggerBlock}.`;
  return [
    `${HEADLINE[r.event] ?? r.event.toUpperCase()} · ${label}`,
    detail,
    "",
    `Target: ${EXPLORER}/entity/${r.subject}`,
    `Receipt: ${EXPLORER}/entity/${r.key}`,
    ...(r.tx ? [`Tx: ${EXPLORER}/tx/${r.tx}`] : []),
  ].join("\n");
}

type Enqueue = (chatId: number, text: string) => void;

// One stream event in, zero or more queued DMs out. Throws on network trouble, so the caller can
// retry the same event before the checkpoint passes it.
export function createHandler(o: {
  client: PublicArkivClient;
  db: Db;
  trusted: readonly Hex[];
  enqueue: Enqueue;
  // The HTTP node's head. Events come over the socket, reads go over HTTP, and that node can trail
  // the socket: a fresh receipt would read as null and be skipped for good (audit M5, as the
  // worker's M7). Without it the lag check is skipped.
  headNow?: () => Promise<bigint>;
}) {
  const owners = new Set(o.trusted.map((a) => a.toLowerCase()));
  return async (e: EntityEvent) => {
    // Free pre-filter: nearly every event on the chain stops here, before any RPC.
    if (e.type !== "EntityCreated" || !owners.has(e.owner.toLowerCase()))
      return;
    const entity = await rawGetEntity(o.client, e.entityKey);
    // Null from a node that hasn't reached the event's block yet says nothing: throw, so the event
    // is retried (and the checkpoint waits). Null from a caught-up node means it's really gone.
    if (!entity && o.headNow && (await o.headNow()) < e.blockNumber)
      throw new Error(`HTTP node behind block ${e.blockNumber}`);
    const r = entity && parseReceipt(entity, o.trusted);
    if (!r) return; // a heartbeat, or already gone
    if (r.event === "keeper_low_funds") {
      // An operator alert (refill the worker), not news about the follower's target.
      console.warn(`[deliver] keeper low on funds: receipt ${r.key}`);
      return;
    }
    const chats = o.db.chatsFor(r.subscription);
    // The label lookup comes before markDelivered: if it throws, the retry must still send.
    let label = `${r.subscription.slice(0, 10)}…`;
    if (chats.length) {
      const sub = await rawGetEntity(o.client, r.subscription);
      const d = sub && decodeSubscription(sub);
      if (d && d.ok) label = d.sub.label;
    }
    // ponytail: marked before the sends finish, so a crash with DMs still queued loses them
    // (at most once). A persistent outbox would make it at least once.
    if (!o.db.markDelivered(r.triggerId)) return;
    const text = formatReceipt({ ...r, tx: e.transactionHash }, label);
    for (const chat of chats) o.enqueue(chat, text);
  };
}

type TelegramError = {
  error_code?: number;
  parameters?: { retry_after?: number };
};

// Telegram's limits (LLD §6.4.5): ≤25 messages/s overall, ≤1/s per chat. A 429 pauses every send
// for retry_after seconds and keeps the message. 400/403 (bad chat, bot blocked) can never succeed,
// so they drop it. Anything else (a network blip, a Telegram 5xx) is transient: that chat backs off
// 1 s, 2 s, 4 s… and the DM is dropped only after SEND_TRIES (~8.5 min). The trigger is already
// marked delivered, so a drop is final (audit M3: 3 quick tries lost every DM in a 3 s outage).
// Per-chat order is kept; a chat backing off never holds up the others.
// `now` and `sleep` are injectable so tests run on a fake clock.
export function createSendQueue({
  send,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  globalGapMs = 40,
  chatGapMs = 1_000,
}: {
  send: (chatId: number, text: string) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  globalGapMs?: number;
  chatGapMs?: number;
}) {
  const jobs: { chatId: number; text: string; tries: number }[] = [];
  const chatFreeAt = new Map<number, number>();
  let globalFreeAt = 0;
  let running: Promise<void> | null = null;

  async function drain() {
    try {
      while (jobs.length) {
        // The oldest job of whichever chat is free soonest.
        // ponytail: O(queue) scan per send; fine for thousands queued, use per-chat lists beyond.
        let pick = 0;
        let pickAt = Infinity;
        const seen = new Set<number>();
        for (let i = 0; i < jobs.length; i++) {
          const chat = jobs[i]!.chatId;
          if (seen.has(chat)) continue;
          seen.add(chat);
          const at = chatFreeAt.get(chat) ?? 0;
          if (at < pickAt) [pick, pickAt] = [i, at];
        }
        const wait = Math.max(pickAt, globalFreeAt) - now();
        if (wait > 0) await sleep(wait);
        const job = jobs[pick]!; // still valid: only this loop removes jobs
        globalFreeAt = now() + globalGapMs;
        chatFreeAt.set(job.chatId, now() + chatGapMs);
        try {
          await send(job.chatId, job.text);
          jobs.splice(pick, 1);
        } catch (e) {
          const { error_code, parameters } = e as TelegramError;
          if (error_code === 429) {
            globalFreeAt = now() + (parameters?.retry_after ?? 1) * 1_000;
            continue;
          }
          if (
            error_code === 400 ||
            error_code === 403 ||
            ++job.tries >= SEND_TRIES
          ) {
            jobs.splice(pick, 1);
            console.error(`[deliver] dropped a DM to ${job.chatId}:`, e);
          } else
            chatFreeAt.set(
              job.chatId,
              now() +
                Math.min(1_000 * 2 ** (job.tries - 1), SEND_BACKOFF_MAX_MS),
            );
        }
      }
      // Idle: forget chats whose gap has passed, so the map doesn't grow forever.
      for (const [chat, at] of chatFreeAt)
        if (at <= now()) chatFreeAt.delete(chat);
    } finally {
      running = null; // synchronous after the last check, so a push can't slip in unseen
    }
  }

  return {
    push(chatId: number, text: string) {
      jobs.push({ chatId, text, tries: 0 });
      // Deferred a tick: drain's `running = null` must run after this assignment, never before.
      running ??= Promise.resolve().then(drain);
    },
    get size() {
      return jobs.length;
    },
    async idle() {
      while (running) await running;
    },
  };
}

// Runs delivery until the returned stop() is called. Events and checkpoint saves share one chain,
// so the checkpoint never passes an event that wasn't handled; a failing event is retried on that
// chain (1 s → 30 s) rather than skipped.
export async function startDelivery(o: {
  ws: StreamOptions["ws"];
  http: PublicArkivClient;
  db: Db;
  trusted: readonly Hex[];
  checkpointFile: string; // keep it next to the DB, on the volume
  send: (chatId: number, text: string) => Promise<unknown>;
}) {
  await mkdir(dirname(o.checkpointFile), { recursive: true });
  // First boot or a testnet wipe: one hour back, like the worker (LLD §3.2 step 1).
  let { block: checkpoint } = await startBlock(
    o.checkpointFile,
    await o.http.getBlockNumber(),
  );
  const queue = createSendQueue({ send: o.send });
  const handle = createHandler({
    client: o.http,
    db: o.db,
    trusted: o.trusted,
    enqueue: queue.push,
    headNow: () => o.http.getBlockNumber(),
  });
  let stopped = false;
  let chain = Promise.resolve();
  const then = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((e) => console.error("[deliver]", e));
  };

  const withRetry = async (e: EntityEvent) => {
    for (let ms = RETRY_MIN_MS; !stopped; ms = Math.min(ms * 2, RETRY_MAX_MS)) {
      try {
        return await handle(e);
      } catch (err) {
        console.error(
          `[deliver] event ${e.transactionHash}:${e.logIndex} failed; retry in ${ms / 1000}s:`,
          err,
        );
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  };

  const stopStream = startStream({
    ws: o.ws,
    http: o.http,
    checkpoint: () => checkpoint,
    onEvent: (e) => then(() => withRetry(e)),
    onHead: (head) =>
      then(async () => {
        // After stop(), the events still on the chain return unhandled (withRetry gives up), so a
        // save queued behind them would skip them for good (audit M2). Leave the checkpoint where
        // it is: the next start replays them.
        if (stopped) return;
        // head − 1 is complete once its events are handled (a block's logs can land just after
        // its head), and every earlier event is already done: they're ahead of us on the chain.
        const block = head - 1n;
        if (block <= checkpoint) return; // a repeated head after a reconnect
        checkpoint = block;
        await saveCheckpoint(o.checkpointFile, block);
      }),
  });

  return async () => {
    stopped = true;
    stopStream();
    await chain;
  };
}
