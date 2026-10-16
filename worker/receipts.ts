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
};

// The target as last seen; pins which entity was watched if one is re-created under the same name.
export type Seen = { creator: Hex; owner: Hex };

const utcDay = () => new Date().toISOString().slice(0, 10);

export class Receipts {
  readonly #writer: Writer;
  readonly #pub: PublicArkivClient;
  readonly #delay: bigint;
  readonly #file: string;
  readonly #trusted: string; // the $creator filter for every receipt count
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

  constructor(o: {
    writer: Writer;
    pub: PublicArkivClient;
    delayBlocks: number;
    file: string;
    trustedWorkers: Hex[];
  }) {
    this.#writer = o.writer;
    this.#pub = o.pub;
    this.#delay = BigInt(o.delayBlocks);
    this.#file = o.file;
    this.#trusted = trustedFilter(o.trustedWorkers);
  }

  get queued() {
    return this.#pending.length;
  }

  // Safe to call on every head while a condition holds: a trigger acts once. Never throws.
  async fire(
    sub: Sub,
    subject: Hex,
    event: Event,
    triggerBlock: bigint,
    seen?: Seen,
  ) {
    const id = triggerId({
      subscription: sub.key,
      subject,
      event,
      triggerBlock,
    });
    if (this.#fired.has(id) || this.#inFlight.has(id) || this.#overCap(sub))
      return;
    // Claim before any await, or every call during B's 15-block wait would pass the checks above.
    this.#inFlight.add(id);
    try {
      while (this.#head < triggerBlock + this.#delay) await this.#tick.promise;
      if (await this.#landed(id)) {
        this.#fired.add(id); // the other worker already acted
        return;
      }
      this.#pending.push({
        id,
        subscription: sub.key,
        subject,
        event,
        triggerBlock,
        doneBlock: this.#head,
        targetCreator: seen?.creator,
        targetOwner: seen?.owner,
      });
      void this.#save();
      this.#countToday(sub.key);
      // Only on success: marking it in `finally` would make one transient RPC error lose the alert.
      this.#fired.add(id);
    } catch (e) {
      console.error(
        `[receipts] ${event} for ${sub.key} failed; retrying on a later head:`,
        e,
      );
    } finally {
      this.#inFlight.delete(id);
    }
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
    const batch = this.#pending.splice(0, BATCH_MAX);
    this.#sending = batch;
    try {
      await this.#save(); // before sending, so a crash mid-send leaves them for resume()
      let r;
      try {
        r = await this.#writer.batch({ creates: batch.map(toCreate) });
      } catch (e) {
        this.#pending.unshift(...batch);
        this.#backoffMs = Math.min(
          this.#backoffMs * 2 || BACKOFF_MIN_MS,
          BACKOFF_MAX_MS,
        );
        this.#retryAt = Date.now() + this.#backoffMs;
        console.error(
          `[receipts] flush of ${batch.length} failed; retry in ${this.#backoffMs / 1000}s:`,
          e,
        );
        return;
      }
      // Refused: the chain rejected the receipts themselves. Resending can't fix a malformed
      // receipt and would block every receipt behind it, so drop the batch and say so loudly.
      if (!r.ok)
        console.error(
          `[receipts] chain refused ${batch.length} receipts, dropped: ${r.reason}`,
          batch.map((b) => b.id),
        );
      this.#backoffMs = 0;
      this.#lastFlush = this.#head;
    } finally {
      this.#sending = [];
      this.#flushing = false;
      void this.#save();
    }
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

const toCreate = (r: Receipt): CreateEntityParameters => ({
  payload: jsonToPayload({
    v: 1,
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
