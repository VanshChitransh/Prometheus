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
import { PROJECT, type Event } from "../shared/schema.ts";
import type { Sub } from "../shared/subscription.ts";
import { triggerId } from "../shared/triggerId.ts";
import type { Keeper } from "./keeper.ts";
import type { Writer } from "./writer.ts";

const FLUSH_AT = 10; // receipts
const FLUSH_EVERY = 5n; // blocks
// ponytail: 50 creates per transaction keeps a post-outage backlog under the block gas limit;
// measure and raise if receipts are routinely backed up.
const BATCH_MAX = 50;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const LIFETIME = ExpirationTime.fromDays(30);

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
    const id = triggerId({
      subscription: sub.key,
      subject,
      event,
      triggerBlock,
    });
    // max_per_day caps alerts; a keep isn't an alert, and skipping one would let the target lapse.
    // Keeps have their own global budget in the keeper.
    if (this.#fired.has(id)) return "done";
    if (this.#inFlight.has(id) || (event !== "keep" && this.#overCap(sub)))
      return "skipped";
    // Claim before any await, or every call during B's 15-block wait would pass the checks above.
    this.#inFlight.add(id);
    try {
      while (this.#head < triggerBlock + this.#delay) await this.#tick.promise;
      if (await this.#landed(id)) {
        this.#fired.add(id); // the other worker already acted
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
          if (receipt)
            this.#queue({
              id: out.id ?? id,
              subscription: sub.key,
              subject,
              triggerBlock,
              ...receipt,
            });
          return "failed"; // not done: offered again on the next head (e.g. after a refill)
        }
      }
      if (receipt) {
        this.#pending.push({
          id,
          subscription: sub.key,
          subject,
          triggerBlock,
          ...receipt,
        });
        void this.#save();
      }
      if (event !== "keep") this.#countToday(sub.key);
      // Only on success: marking it in `finally` would make one transient RPC error lose the alert.
      this.#fired.add(id);
      return "done";
    } catch (e) {
      console.error(`[receipts] ${event} for ${sub.key} failed:`, e);
      return "failed";
    } finally {
      this.#inFlight.delete(id);
    }
  }

  #queue(r: Receipt) {
    this.#pending.push(r);
    void this.#save();
  }

  onHead(head: bigint) {
    if (head <= this.#head) return;
    this.#head = head;
    this.#tick.resolve(); // wakes every fire() waiting for its block
    this.#tick = Promise.withResolvers<void>();
    if (
      this.#pending.length >= FLUSH_AT ||
      (this.#pending.length > 0 && head - this.#lastFlush >= FLUSH_EVERY)
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
    const landed = await Promise.all(saved.map((r) => this.#landed(r.id)));
    this.#pending = saved.filter((_, i) => !landed[i]);
    for (const r of saved) this.#fired.add(r.id);
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
      this.#retryAt = Date.now() + this.#backoffMs;
      console.error(
        `[receipts] flush of ${batch.length} failed; retry in ${this.#backoffMs / 1000}s:`,
        e,
      );
    } finally {
      this.#sending = [];
      this.#flushing = false;
      void this.#save();
    }
  }

  // Free counts for many receipts, 16 at a time (the measured safe concurrency).
  async #landedAll(rs: Receipt[]) {
    const out: boolean[] = [];
    for (let i = 0; i < rs.length; i += 16)
      out.push(
        ...(await Promise.all(
          rs.slice(i, i + 16).map((r) => this.#landed(r.id)),
        )),
      );
    return out;
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
    return (await freeCount(this.#pub, q)) > 0;
  }

  // Restores today's count after a restart (T2.8), from the receipts already on chain.
  seedDayCount(subKey: Hex, n: number) {
    this.#dayCount.set(subKey, { day: utcDay(), n });
  }

  #overCap(sub: Sub) {
    const c = this.#dayCount.get(sub.key);
    return c?.day === utcDay() && c.n >= sub.maxPerDay;
  }

  #countToday(subKey: Hex) {
    const day = utcDay();
    const c = this.#dayCount.get(subKey);
    this.#dayCount.set(subKey, { day, n: c?.day === day ? c.n + 1 : 1 });
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
