// The LLD §3.3 table: turns stream events into updates of the subscription index and the target
// cache, and tells the entrypoint when a block is fully handled so the checkpoint can pass it.
// Node only.
import type {
  EntityCreatedEvent,
  EntityEvent,
  PublicArkivClient,
} from "@arkiv-network/sdk";
import type { Hex } from "viem";
import { freeCount, rawGetEntity } from "../shared/arkiv.ts";
import { PROJECT } from "../shared/schema.ts";
import { decodeSubscription } from "../shared/subscription.ts";
import { fireChanged } from "./change.ts";
import type { Targets } from "./expiry.ts";
import { matchCreated, type Later } from "./match.ts";
import type { Receipts } from "./receipts.ts";
import type { SubsIndex } from "./subs.ts";

const MAX_IN_FLIGHT = 16;
const MAX_ATTEMPTS = 10; // ~4 min of backoff (1 s → 30 s) before a persistent failure is dropped

export function createDispatch(o: {
  pub: PublicArkivClient;
  subs: () => SubsIndex; // a getter: the hourly re-sync swaps in a fresh index
  targets: Targets;
  receipts: Pick<Receipts, "fire">;
  trustedWorkers: readonly Hex[];
  retryBaseMs?: number; // first backoff step; tests shrink it
}) {
  const retryBaseMs = o.retryBaseMs ?? 1_000;
  const { pub, subs, targets, receipts } = o;
  const blocks = new Map<bigint, Promise<void>[]>();
  // A catch-up replays thousands of events at once; unbounded, each EntityCreated's free count hit
  // the node together and ~100 timed out (1,697-block replay, 16 Oct). Measured 17 Oct: 16 in flight
  // drains ~49 counts/s with no errors, so an hour of catch-up (~3,800 events) takes ~80 s.
  let active = 0;
  const waiting: (() => void)[] = [];
  async function limited<T>(fn: () => Promise<T>) {
    while (active >= MAX_IN_FLIGHT)
      await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  // An event is never offered again (unlike an expiry, re-checked every head), so a handler or its
  // fires that fail are retried, and the block doesn't settle meanwhile: the checkpoint waits rather
  // than skip an alert. Every step is idempotent (subs re-add in place, fires dedupe by trigger id).
  // ponytail: after MAX_ATTEMPTS it gives up loudly, so one permanent bug can't freeze the worker.
  async function retrying<T>(what: string, fn: () => Promise<T>) {
    for (let attempt = 1, delay = retryBaseMs; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          console.error(
            `[events] ${what} failed ${attempt} times; dropped:`,
            err,
          );
          return undefined;
        }
        console.warn(
          `[events] ${what} failed (attempt ${attempt}); retrying in ${delay / 1000}s: ${(err as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30 * retryBaseMs);
      }
    }
  }

  async function created(e: EntityCreatedEvent): Promise<Later | void> {
    // Free count first: ~1 event/s chain-wide, and almost none are our subscriptions. The node
    // insists on typed hex literals, so key(…), not a bare 0x… (measured 17 Oct).
    const q = `project = str('${PROJECT}') AND kind = str('subscription') AND $key = key(${e.entityKey})`;
    if ((await freeCount(pub, q)) === 1) return addSubscription(e.entityKey);
    // A watched target appearing: everything the cache needs is in the event (creator = owner at birth).
    if (subs().forTarget(e.entityKey).length > 0)
      targets.set(e.entityKey, {
        expiresAt: e.expiresAt,
        creator: e.owner,
        owner: e.owner,
        flags: {
          readonly: e.creationFlags.readonly,
          permissionlessExtension: e.creationFlags.permissionlessExtension,
        },
      });
    return matchCreated({
      e,
      subs: subs().all(),
      pub,
      receipts,
      workers: o.trustedWorkers,
    });
  }

  // Same path as discovery: a free raw read, decoded exactly as the web form decodes it.
  async function addSubscription(key: Hex) {
    const raw = await rawGetEntity(pub, key);
    if (!raw) return; // deleted or expired already
    const d = decodeSubscription(raw);
    if (!d.ok)
      return console.warn(`[events] subscription ${key} rejected: ${d.reason}`);
    const r = subs().add(d.sub);
    if (!r.ok)
      return console.warn(`[events] subscription ${key} rejected: ${r.reason}`);
    if (r.evicted)
      console.warn(
        `[events] subscription ${r.evicted.key} evicted: ${key} is older`,
      );
    const target = d.sub.targetKey;
    if (target && !targets.get(target) && !(await targets.seed(pub, target)))
      console.warn(
        `[events] subscription ${key} watches ${target}, already gone`,
      );
    console.log(`[events] subscription ${key} added (${d.sub.trigger})`);
  }

  // The trigger block is the event's block. Seen is read now, before any cache update that follows.
  function changed(
    k: Hex,
    event: "patched" | "owner_changed" | "deleted",
    block: bigint,
  ) {
    const t = targets.get(k);
    return fireChanged({
      subs: subs().forTarget(k),
      subject: k,
      event,
      block,
      seen: t && { creator: t.creator, owner: t.owner },
      receipts,
    });
  }

  async function handle(e: EntityEvent): Promise<Later | void> {
    switch (e.type) {
      case "EntityCreated":
        return created(e);
      case "ExpiryExtended": {
        targets.extend(e.entityKey, e.expiresAt); // no-op unless watched
        const sub = subs().get(e.entityKey);
        if (sub) subs().add({ ...sub, expiresAt: e.expiresAt }); // the subscription was renewed
        return;
      }
      case "EntityPatched":
        return changed(e.entityKey, "patched", e.blockNumber);
      case "OwnershipTransferred":
        // The SDK decodes topics[2] = previous, topics[3] = new; the receipt pins the new owner.
        targets.transfer(e.entityKey, e.newOwner);
        return changed(e.entityKey, "owner_changed", e.blockNumber);
      case "EntityDeleted": {
        // Before the cache entry goes: the receipt needs the creator and owner it holds.
        const later = changed(e.entityKey, "deleted", e.blockNumber);
        targets.delete(e.entityKey);
        subs().remove(e.entityKey);
        return later;
      }
    }
  }

  return {
    // A block's events run concurrently (LLD §3.3), at most 16 at a time across blocks; each is filed
    // under its block for settle().
    onEvent(e: EntityEvent) {
      // A handler's Later runs after its slot is freed, but still before the block settles. Each
      // phase retries on its own, so a failed fire doesn't redo the handler's counts; backoff sleeps
      // never hold a dispatch slot.
      const what = `${e.type} ${e.entityKey}`;
      const done = retrying(what, () => limited(() => handle(e)))
        .then((later) => later && retrying(`${what} receipts`, later))
        .then(() => {});
      const list = blocks.get(e.blockNumber);
      if (list) list.push(done);
      else blocks.set(e.blockNumber, [done]);
    },

    // Resolves once every event in blocks <= upTo has been handled; only then may the checkpoint pass them.
    async settle(upTo: bigint) {
      const pending: Promise<void>[] = [];
      for (const [block, list] of blocks)
        if (block <= upTo) {
          pending.push(...list);
          blocks.delete(block);
        }
      await Promise.all(pending);
    },
  };
}
