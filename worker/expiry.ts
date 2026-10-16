// The core (LLD §3.4): turns heads into warned/expired triggers with zero queries per block. The
// target cache holds each watched target's expiry; the only RPC is one free read per real expiry,
// confirming the target left (or catching an extension we missed). Node only.
import type { PublicArkivClient } from "@arkiv-network/sdk";
import type { Hex } from "viem";
import { rawGetEntity, type RawEntity } from "../shared/arkiv.ts";
import type { Sub } from "../shared/subscription.ts";
import type { Receipts, Seen } from "./receipts.ts";
import type { SubsIndex } from "./subs.ts";

// creator/owner feed the receipt payload: an expired target is gone by the time the receipt is
// written, so they must be remembered (03 G-31). `gone` = confirmed expired.
export type Target = {
  expiresAt: bigint;
  creator: Hex;
  owner: Hex;
  flags: RawEntity["flags"];
  gone: boolean;
};

export type Fire = {
  sub: Sub;
  target: Hex;
  event: "warned" | "expired" | "keep";
  triggerBlock: bigint;
  seen: Seen;
};

// Event keys arrive lowercase; a target_key attribute may not.
const lower = (k: Hex) => k.toLowerCase() as Hex;

export class Targets {
  readonly #m = new Map<Hex, Target>();
  // Bumped by every change to a key, so a read that started before the change knows it's stale.
  // ponytail: one small number per target ever seen, never pruned; fine at thousands.
  readonly #version = new Map<Hex, number>();

  get size() {
    return this.#m.size;
  }

  get(k: Hex) {
    return this.#m.get(lower(k));
  }

  #touch(k: Hex) {
    this.#version.set(k, (this.#version.get(k) ?? 0) + 1);
    return this.#m.get(k);
  }

  set(k: Hex, t: Omit<Target, "gone">) {
    this.#touch(lower(k));
    this.#m.set(lower(k), { ...t, gone: false });
  }

  // An extension also proves the target is alive.
  extend(k: Hex, expiresAt: bigint) {
    const t = this.#touch(lower(k));
    if (t) Object.assign(t, { expiresAt, gone: false });
  }

  // Receipts pin the owner as last seen, so a transfer must reach the cache.
  transfer(k: Hex, owner: Hex) {
    const t = this.#touch(lower(k));
    if (t) t.owner = owner;
  }

  markGone(k: Hex) {
    const t = this.#touch(lower(k));
    if (t) t.gone = true;
  }

  delete(k: Hex) {
    this.#touch(lower(k));
    this.#m.delete(lower(k));
  }

  entries() {
    return this.#m.entries();
  }

  // One free read. Caches a live target; false = it's gone (never existed, deleted or expired). If an
  // event changed the key while the read was in flight, the event is newer: keep what it wrote.
  async seed(pub: PublicArkivClient, k: Hex) {
    const key = lower(k);
    const before = this.#version.get(key);
    const e = await rawGetEntity(pub, k);
    if (this.#version.get(key) !== before) {
      const now = this.#m.get(key);
      return !!now && !now.gone;
    }
    if (!e) return false;
    this.set(k, {
      expiresAt: e.expiresAt,
      creator: e.creator,
      owner: e.owner,
      flags: e.flags,
    });
    return true;
  }
}

// Pure: what's due at `head`, and which targets need a free read to confirm they expired. No RPC.
// A target counts as expired at head >= expiresAt (the node treats an entity as live iff
// expiresAt > block). fire() is idempotent through triggerId, so returning a trigger on every head
// while its condition holds is intended. A keep trigger goes to the keeper through fire() (T2.11).
// ponytail: linear scan of the cache each block; switch to a min-heap if targets > ~5k.
export function dueTriggers(head: bigint, targets: Targets, subs: SubsIndex) {
  const fires: Fire[] = [];
  const confirm: Hex[] = [];
  for (const [target, t] of targets.entries()) {
    const seen = { creator: t.creator, owner: t.owner };
    for (const sub of subs.forTarget(target)) {
      if ((sub.trigger === "expiring" || sub.trigger === "keep") && !t.gone) {
        // Once a keep lands, ExpiryExtended moves expiresAt, so the next cycle re-arms on its own.
        const triggerBlock = t.expiresAt - sub.leadBlocks!;
        const event = sub.trigger === "keep" ? "keep" : "warned";
        if (head >= triggerBlock)
          fires.push({ sub, target, event, triggerBlock, seen });
      }
      if (sub.trigger === "expired" && t.gone)
        fires.push({
          sub,
          target,
          event: "expired",
          triggerBlock: t.expiresAt,
          seen,
        });
    }
    if (!t.gone && head >= t.expiresAt) confirm.push(target);
  }
  return { fires, confirm };
}

export class ExpiryMonitor {
  readonly #pub: PublicArkivClient;
  readonly #targets: Targets;
  readonly #subs: () => SubsIndex;
  readonly #receipts: Pick<Receipts, "fire">;
  readonly #confirming = new Set<Hex>(); // one read per target at a time, not one per head

  constructor(o: {
    pub: PublicArkivClient;
    targets: Targets;
    subs: () => SubsIndex; // a getter: the hourly re-sync swaps in a fresh index
    receipts: Pick<Receipts, "fire">;
  }) {
    this.#pub = o.pub;
    this.#targets = o.targets;
    this.#subs = o.subs;
    this.#receipts = o.receipts;
  }

  onHead(head: bigint) {
    const subs = this.#subs();
    // A target nobody watches any more (its subscriptions removed) costs reads for nothing.
    for (const [k] of this.#targets.entries())
      if (subs.forTarget(k).length === 0) this.#targets.delete(k);
    const { fires, confirm } = dueTriggers(head, this.#targets, subs);
    for (const f of fires)
      void this.#receipts.fire(
        f.sub,
        f.target,
        f.event,
        f.triggerBlock,
        f.seen,
      );
    for (const k of confirm) void this.#confirm(k);
  }

  // Null → gone: `expired` fires from the next head on, and keeps being offered until it succeeds.
  // Alive → we missed its extension: resync, so this isn't asked again every block (03 G-32).
  async #confirm(k: Hex) {
    if (this.#confirming.has(k)) return;
    this.#confirming.add(k);
    try {
      const e = await rawGetEntity(this.#pub, k);
      if (!e) this.#targets.markGone(k);
      else this.#targets.extend(k, e.expiresAt);
    } catch (e) {
      console.error(`[expiry] confirming ${k} failed; retrying next head:`, e);
    } finally {
      this.#confirming.delete(k);
    }
  }
}
