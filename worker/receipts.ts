// Turns a trigger into at most one receipt per worker (LLD §3.5): an in-flight claim before any
// await, B's delay_blocks failover, a free "already done?" count, and batched flushes that survive a
// restart through the pending file. Node only.
import { readFile, rename, writeFile } from "node:fs/promises";
import type {
  CreateEntityParameters,
  PublicArkivClient,
} from "@arkiv-network/sdk";
import { bytes32, key, u64 } from "@arkiv-network/sdk/attr";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
import type { Hex } from "viem";
import { freeCount, trustedFilter } from "../shared/arkiv.ts";
import { LIFETIMES, PROJECT, type Event } from "../shared/schema.ts";
import type { Sub } from "../shared/subscription.ts";
import { triggerId } from "../shared/triggerId.ts";
import type { Keeper } from "./keeper.ts";
import { createLimiter, inBatches } from "../shared/limit.ts";
import type { Writer } from "./writer.ts";

const FLUSH_AT = 10; // receipts
const FLUSH_EVERY = 5n; // blocks
// ponytail: 50 creates per transaction keeps a post-outage backlog under the block gas limit;
// measure and raise if receipts are routinely backed up.
const BATCH_MAX = 50;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// A keep the keeper deferred (low funds, spent budget) waits this long before it's offered again:
// each offer costs 3 free RPCs, and the monitor offers every due keep on every head (WK-5).
const RETRY_BLOCKS = 10n;
const RECHECK_MIN_MS = 10_000; // after a thrown send: time for a tx that did go out to be indexed
const LIFETIME = ExpirationTime.fromDays(LIFETIMES.receiptDays);
// Keep outcomes aren't alerts, so they never use a max_per_day slot (see fire()).
const KEEP_EVENTS: ReadonlySet<string> = new Set([
  "kept",
  "keep_skipped",
  "keep_failed",
  "keeper_low_funds",
]);

export type Receipt = {
  id: Hex;
  subscription: Hex;
  subject: Hex;
  event: Event;
  triggerBlock: bigint;
  doneBlock: bigint;
  targetCreator?: Hex;
  targetOwner?: Hex;
  note?: string; // why a keep was skipped or failed
};

// The target as last seen; pins which entity was watched if one is re-created under the same name.
export type Seen = { creator: Hex; owner: Hex };

// done = acted, or someone already did; skipped = not this call's job (in flight elsewhere, or over
// the daily cap); failed = an error or a "try again" outcome: the trigger isn't marked done.
export type FireResult = "done" | "skipped" | "failed";

// For callers whose trigger is never offered again (changed, new_match): throw so they retry.
export function throwIfFailed(results: FireResult[]) {
  if (results.includes("failed")) throw new Error("a receipt fire failed");
}

const utcDay = () => new Date().toISOString().slice(0, 10);

export class Receipts {
  readonly #writer: Writer;
  readonly #pub: PublicArkivClient;
  readonly #delay: bigint;
  readonly #file: string;
  readonly #trusted: string; // the $creator filter for every receipt count
  readonly #keeper?: Pick<Keeper, "keep">;
  // ponytail: one id per trigger, never pruned; fine at hundreds a day, prune by trigger block if
  // it ever reaches millions. Rebuilt from receipts on restart (T2.8).
  readonly #fired = new Set<Hex>(); // done here or found on chain (fast path; the truth is on Arkiv)
  readonly #inFlight = new Set<Hex>(); // claimed, not finished
  readonly #deferred = new Map<Hex, bigint>(); // keep triggers to skip until this head (WK-5)
  // fire() runs outside the dispatch limiter: a burst (a restart's first head, a replayed block of
  // patches) sent every "already done?" count at once (WK-7).
  readonly #limit = createLimiter(8);
  readonly #dayCount = new Map<Hex, { day: string; n: number }>();
  #pending: Receipt[] = [];
  #sending: Receipt[] = [];
  #head = 0n;
  #tick = Promise.withResolvers<void>();
  #lastFlush = 0n;
  #flushing = false;
  #backoffMs = 0;
  #retryAt = 0;
  #saving = Promise.resolve();
  #solo = 0; // receipts at the queue's head to send one per tx: a refused batch is being bisected
  #recheck = false; // the last send threw but may have landed: filter before resending

  constructor(o: {
    writer: Writer;
    pub: PublicArkivClient;
    delayBlocks: number;
    file: string;
    trustedWorkers: Hex[];
    keeper?: Pick<Keeper, "keep">; // acts on "keep" triggers (T2.11)
  }) {
    this.#writer = o.writer;
    this.#pub = o.pub;
    this.#delay = BigInt(o.delayBlocks);
    this.#file = o.file;
    this.#trusted = trustedFilter(o.trustedWorkers);
    this.#keeper = o.keeper;
  }

  get queued() {
    return this.#pending.length;
  }

  // Safe to call on every head while a condition holds: a trigger acts once. Never throws; reports
  // a FireResult instead, so event-driven callers can retry what an expiry would re-offer itself.
  // "keep" goes to the keeper, which writes its own receipt: `kept` atomically with the extension,
  // or a skip/failure outcome that's queued here like any other receipt.
  async fire(
    sub: Sub,
    subject: Hex,
    event: Event | "keep",
    triggerBlock: bigint,
    seen?: Seen,
  ): Promise<FireResult> {
    let id: Hex;
    try {
      id = triggerId({ subscription: sub.key, subject, event, triggerBlock });
    } catch (e) {
      // e.g. a negative block (expiry before lead_blocks, possible on a freshly wiped chain): not a
      // trigger anyone can act on. Must not throw: callers fire-and-forget.
      console.error(`[receipts] bad trigger for ${sub.key}:`, e);
      return "skipped";
    }
    // max_per_day caps alerts; a keep isn't an alert, and skipping one would let the target lapse.
    // Keeps have their own global budget in the keeper.
    if (this.#fired.has(id)) return "done";
    if ((this.#deferred.get(id) ?? -1n) > this.#head) return "skipped";
    if (this.#inFlight.has(id) || (event !== "keep" && this.#overCap(sub)))
      return "skipped";
    // Claim before any await, or every call during B's 15-block wait would pass the checks above.
    // The day slot too: counted only after the awaits, 100 concurrent fires all passed the cap (H4).
    this.#inFlight.add(id);
    const counted = event !== "keep";
    if (counted) this.#countToday(sub.key, 1);
    try {
      while (this.#head < triggerBlock + this.#delay) await this.#tick.promise;
      if (await this.#landed(id)) {
        // The other worker already acted. The slot stays used: the cap is per subscription, not
        // per worker. Giving it back let A and B each count only their own writes, so a cap of 20
        // let up to 40 alerts through (audit M4). The restart rebuild counts both workers too.
        this.#fired.add(id);
        return "done";
      }
      let receipt:
        | Omit<Receipt, "id" | "subscription" | "subject" | "triggerBlock">
        | undefined;
      if (event !== "keep")
        receipt = {
          event,
          doneBlock: this.#head,
          targetCreator: seen?.creator,
          targetOwner: seen?.owner,
        };
      else {
        if (!this.#keeper) throw new Error("no keeper configured");
        const out = await this.#keeper.keep({
          sub,
          target: subject,
          id,
          triggerBlock,
          head: this.#head,
        });
        // undefined: kept, and the extension's own transaction already wrote the receipt.
        if (out?.event)
          receipt = {
            event: out.event,
            note: out.note,
            doneBlock: this.#head,
            targetCreator: out.seen?.creator,
            targetOwner: out.seen?.owner,
          };
        if (out?.retry) {
          this.#deferred.set(id, this.#head + RETRY_BLOCKS);
          // Said once per trigger; after a restart the keeper forgot it did (WK-8).
          if (receipt && !(await this.#landed(out.id ?? id)))
            await this.#queue({
              id: out.id ?? id,
              subscription: sub.key,
              subject,
              triggerBlock,
              ...receipt,
            });
          return "failed"; // not done: offered again on the next head (e.g. after a refill)
        }
      }
      // Awaited: "done" lets the block settle and the checkpoint pass it, so the receipt must be on
      // disk first, or a crash in between loses a change/match receipt for good (audit).
      if (receipt)
        await this.#queue({
          id,
          subscription: sub.key,
          subject,
          triggerBlock,
          ...receipt,
        });
      // Only on success: marking it in `finally` would make one transient RPC error lose the alert.
      this.#fired.add(id);
      this.#deferred.delete(id);
      return "done";
    } catch (e) {
      console.error(`[receipts] ${event} for ${sub.key} failed:`, e);
      if (counted) this.#countToday(sub.key, -1); // give the slot back: it's tried again
      return "failed";
    } finally {
      this.#inFlight.delete(id);
    }
  }

  #queue(r: Receipt) {
    this.#pending.push(r);
    return this.#save();
  }

  // Graceful shutdown: one last flush attempt, then wait for the pending file to be written.
  async close() {
    if (this.#pending.length > 0) await this.#flush();
    await this.#saving;
  }

  onHead(head: bigint) {
    if (head <= this.#head) return;
    this.#head = head;
    this.#tick.resolve(); // wakes every fire() waiting for its block
    this.#tick = Promise.withResolvers<void>();
    // While a refused batch is bisected (one receipt per tx), flush every head: at the usual 5-block
    // rhythm, N receipts took ~5N blocks and B's 15-block failover wrote duplicates of all of them.
    if (
      this.#pending.length >= FLUSH_AT ||
      (this.#pending.length > 0 &&
        (this.#solo > 0 || head - this.#lastFlush >= FLUSH_EVERY))
    )
      void this.#flush();
  }

  // On startup: requeue what a crash left in the pending file, minus what already landed (a crash
  // after a batch landed but before the file was cleared would otherwise write it twice).
  async resume() {
    let saved: Receipt[];
    try {
      saved = (JSON.parse(await readFile(this.#file, "utf8")) as Receipt[]).map(
        (r) => ({
          ...r,
          triggerBlock: BigInt(r.triggerBlock),
          doneBlock: BigInt(r.doneBlock),
        }),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e; // a corrupt file must be looked at, not silently dropped with its receipts
    }
    // Batched (an outage can leave thousands), and a failed check keeps the receipt: a possible
    // duplicate is better than a lost alert, or a crash loop at startup.
    const landed = await inBatches(saved, (r) =>
      this.#landed(r.id).catch(() => false),
    );
    this.#pending = saved.filter((_, i) => !landed[i]);
    for (const r of saved) this.#fired.add(r.id);
    // Unsent alerts use today's slots too, but they aren't on chain, so the restart's chain count
    // (rebuildDayCounts → seedDayCount, which adds to this) can't see them.
    for (const r of this.#pending)
      if (!KEEP_EVENTS.has(r.event)) this.#countToday(r.subscription, 1);
    console.log(
      `[receipts] resumed ${this.#pending.length} unsent receipts (${saved.length - this.#pending.length} already on chain)`,
    );
    await this.#save();
  }

  async #flush() {
    if (this.#flushing || Date.now() < this.#retryAt) return;
    this.#flushing = true;
    const solo = this.#solo > 0;
    let batch = this.#pending.splice(0, solo ? 1 : BATCH_MAX);
    this.#sending = batch;
    try {
      if (this.#recheck) {
        // The last send threw after it may have gone out (e.g. its receipt wait timed out):
        // anything that landed must not be written twice.
        const landed = await this.#landedAll(batch);
        batch = batch.filter((_, i) => !landed[i]);
        this.#sending = batch;
        this.#recheck = false;
      }
      if (batch.length > 0) {
        await this.#save(); // before sending, so a crash mid-send leaves them for resume()
        const r = await this.#writer.batch({
          creates: batch.map(receiptCreate),
        });
        if (!r.ok && batch.length > 1) {
          // One malformed receipt refuses the whole batch. Resend one per tx, so only it is lost.
          this.#pending.unshift(...batch);
          this.#solo = batch.length;
          console.warn(
            `[receipts] chain refused a batch of ${batch.length} (${r.errorName}); resending one at a time`,
          );
          return;
        }
        // A refused single receipt is our bug (the engine named what's wrong): resending can't fix
        // it and would block the queue, so drop it and say so loudly.
        if (!r.ok)
          console.error(
            `[receipts] chain refused receipt ${batch[0]!.id}, dropped: ${r.reason}`,
          );
      }
      if (solo) this.#solo--;
      this.#backoffMs = 0;
      this.#lastFlush = this.#head;
    } catch (e) {
      // Network trouble (or a failed recheck): requeue, back off, and recheck before resending.
      this.#pending.unshift(...batch);
      this.#recheck = true;
      this.#backoffMs = Math.min(
        this.#backoffMs * 2 || BACKOFF_MIN_MS,
        BACKOFF_MAX_MS,
      );
      // The recheck must see the tx if it did go out, so give the node time to index it: after 1 s
      // it counted 0 and resent, writing duplicates. 10 s (5 blocks) is still well inside B's
      // 15-block (30 s) failover window.
      const wait = Math.max(this.#backoffMs, RECHECK_MIN_MS);
      this.#retryAt = Date.now() + wait;
      console.error(
        `[receipts] flush of ${batch.length} failed; retry in ${wait / 1000}s:`,
        e,
      );
    } finally {
      this.#sending = [];
      this.#flushing = false;
      void this.#save();
    }
  }

  #landedAll(rs: Receipt[]) {
    return inBatches(rs, (r) => this.#landed(r.id));
  }

  // The file mirrors the outbox (sending + pending). Writes are chained so two never race on the
  // temp file, and a failed write is logged, never thrown: losing crash safety beats losing receipts.
  #save() {
    const all = [...this.#sending, ...this.#pending];
    this.#saving = this.#saving
      .then(async () => {
        const tmp = `${this.#file}.tmp`;
        await writeFile(
          tmp,
          JSON.stringify(all, (_, v) =>
            typeof v === "bigint" ? String(v) : v,
          ),
        );
        await rename(tmp, this.#file);
      })
      .catch((e) =>
        console.error("[receipts] saving the pending file failed:", e),
      );
    return this.#saving;
  }

  // Schema query #2: has a trusted worker already written a receipt for this trigger? Free.
  // Trusted only: trigger_id is computable by anyone, so without the $creator filter a forged
  // receipt from any wallet would make both workers skip the real alert.
  async #landed(id: Hex) {
    const q = `project = str('${PROJECT}') AND kind = str('receipt') AND trigger_id = bytes32(${id}) AND ${this.#trusted}`;
    return (await this.#limit(() => freeCount(this.#pub, q))) > 0;
  }

  // Restores today's count after a restart (T2.8), from the receipts already on chain. Adds to what
  // resume() counted from the pending file, which the chain count can't see.
  seedDayCount(subKey: Hex, n: number) {
    this.#countToday(subKey, n);
  }

  #overCap(sub: Sub) {
    const c = this.#dayCount.get(sub.key);
    return c?.day === utcDay() && c.n >= sub.maxPerDay;
  }

  #countToday(subKey: Hex, delta: number) {
    const day = utcDay();
    const c = this.#dayCount.get(subKey);
    const n = (c?.day === day ? c.n : 0) + delta;
    this.#dayCount.set(subKey, { day, n: Math.max(0, n) });
  }
}

// Every receipt is built here, including the keeper's atomic `kept` one (LLD §2.3).
export const receiptCreate = (r: Receipt): CreateEntityParameters => ({
  payload: jsonToPayload({
    v: 1,
    note: r.note,
    target_creator: r.targetCreator,
    target_owner: r.targetOwner,
  }),
  contentType: "application/json",
  attributes: {
    project: PROJECT,
    kind: "receipt",
    trigger_id: bytes32(r.id),
    subscription: key(r.subscription),
    subject: key(r.subject),
    event: r.event,
    trigger_block: u64(r.triggerBlock),
    done_block: u64(r.doneBlock),
  },
  flags: { readonly: true }, // can't be rewritten; a deletion would itself be public
  expires: LIFETIME,
});
