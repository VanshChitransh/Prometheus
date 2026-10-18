// The LLD §3.3 table: turns stream events into updates of the subscription index and the target
// cache, and tells the entrypoint when a block is fully handled so the checkpoint can pass it.
// Node only.
import type { EntityEvent, PublicArkivClient } from "@arkiv-network/sdk";
import type { Hex } from "viem";
import { freeCount, rawGetEntity } from "../shared/arkiv.ts";
import { PROJECT } from "../shared/schema.ts";
import { decodeSubscription } from "../shared/subscription.ts";
import { fireChanged } from "./change.ts";
import type { Targets } from "./expiry.ts";
import { createLimiter } from "../shared/limit.ts";
import { matchCreated, type Later } from "./match.ts";
import type { Receipts } from "./receipts.ts";
import { seedGone } from "./startup.ts";
import type { SubsIndex } from "./subs.ts";

const MAX_ATTEMPTS = 10; // ~2.5 min of backoff (1 s → 30 s) before a persistent failure is dropped

// What an event leaves to do after its synchronous cache updates: RPC work (through the limiter),
// and receipts to fire once that's done.
type Step = { rpc?: () => Promise<Later | void>; later?: Later };

export function createDispatch(o: {
  pub: PublicArkivClient;
  subs: () => SubsIndex; // a getter: the hourly re-sync swaps in a fresh index
  targets: Targets;
  receipts: Pick<Receipts, "fire">;
  trustedWorkers: readonly Hex[];
  retryBaseMs?: number; // first backoff step; tests shrink it
  // The HTTP node's head. Free counts read the HTTP node, which can trail the socket that delivered
  // the event, so a count for a just-created entity could say 0 (audit M7); counts aren't pinned to
  // the event's block yet (the count takes `block`, not `atBlock`). index.ts wires it; without it
  // the wait is skipped. Known limit: a replayed event is counted against the current state.
  headNow?: () => Promise<bigint>;
  // The block startup discovery read every live subscription at (discoverAll). A creation at or
  // before it is already indexed or gone, so it needs no subscription count: a 12 h catch-up
  // replays ~33k chain-wide creations, and counting each one left the worker deaf for ~20 minutes
  // (audit M1, measured 17 Oct). Unset = count every creation.
  discoveredAt?: bigint;
}) {
  const retryBaseMs = o.retryBaseMs ?? 1_000;
  let httpHead = 0n;
  // Waits (≤ ~5 s) until the HTTP node has the event's block; one head read per block, not per event.
  async function caughtUp(block: bigint) {
    if (!o.headNow) return;
    for (let i = 0; httpHead < block && i < 10; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500));
      httpHead = await o.headNow();
    }
  }
  const { pub, subs, targets, receipts } = o;
  const blocks = new Map<bigint, Promise<void>[]>();
  // A catch-up replays thousands of events at once; unbounded, each EntityCreated's free count hit
  // the node together and ~100 timed out (1,697-block replay, 16 Oct).
  const limited = createLimiter();

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

  // Same path as discovery: a free raw read, decoded exactly as the web form decodes it. Also used
  // when a subscription is patched: its fields may have changed, or it may no longer be valid.
  async function addSubscription(key: Hex) {
    const raw = await rawGetEntity(pub, key);
    if (!raw) return void subs().remove(key); // deleted or expired already
    const d = decodeSubscription(raw);
    if (!d.ok) {
      subs().remove(key); // a patch can make a served subscription invalid
      return console.warn(`[events] subscription ${key} rejected: ${d.reason}`);
    }
    const r = subs().add(d.sub);
    if (!r.ok)
      return console.warn(`[events] subscription ${key} rejected: ${r.reason}`);
    if (r.evicted)
      console.warn(
        `[events] subscription ${r.evicted.key} evicted: ${key} is older`,
      );
    const target = d.sub.targetKey;
    if (target && !targets.get(target) && !(await targets.seed(pub, target))) {
      // LLD §3.8: the target must exist, except for `expired` (it may already have lapsed).
      if (d.sub.trigger !== "expired") {
        subs().remove(key);
        // Not a deletion: the hourly re-sync may serve it, and its prune drops it if still dead.
        subs().removed.delete(key.toLowerCase() as Hex);
        return console.warn(
          `[events] subscription ${key} rejected: its target ${target} doesn't exist`,
        );
      }
      // An `expired` sub on a target that already lapsed: find its real expiry now, as startup
      // does, or `expired` waited for the hourly re-sync. A throw retries the event.
      if (o.headNow) await seedGone(pub, targets, target, await o.headNow());
    }
    console.log(`[events] subscription ${key} added (${d.sub.trigger})`);
  }

  // The trigger block is the event's block; `seen` is read now, before any cache update that follows.
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

  // Every cache and index update happens here, synchronously, in the order events arrive (= chain
  // order). Only RPC work is deferred. A handler that mutated the cache after an await let an older
  // event overwrite a newer one during a replay (audit H3): a created applied after its own extension
  // reset the expiry and fired a false `warned`; after its deletion, a false `expired`.
  function apply(e: EntityEvent): Step {
    const k = e.entityKey;
    switch (e.type) {
      case "EntityCreated": {
        // A watched target appearing: everything the cache needs is in the event (creator = owner
        // at birth). Never over an existing entry: that's the same or newer state (seeded at startup,
        // or already marked gone), and a replayed creation must not resurrect it.
        if (subs().forTarget(k).length > 0 && !targets.get(k))
          targets.set(k, {
            expiresAt: e.expiresAt,
            creator: e.owner,
            owner: e.owner,
            flags: {
              readonly: e.creationFlags.readonly,
              permissionlessExtension: e.creationFlags.permissionlessExtension,
            },
          });
        const known =
          subs().get(k) !== undefined ||
          (o.discoveredAt !== undefined && e.blockNumber <= o.discoveredAt);
        return {
          rpc: async () => {
            await caughtUp(e.blockNumber);
            // Free count first: ~1 event/s chain-wide, and almost none are our subscriptions. The
            // node insists on typed hex literals, so key(…), not a bare 0x… (measured 17 Oct).
            if (!known) {
              const q = `project = str('${PROJECT}') AND kind = str('subscription') AND $key = key(${k})`;
              if ((await freeCount(pub, q)) === 1) return addSubscription(k);
            }
            // new_match still sees every replayed creation: those made while we were down count.
            // ponytail: a new_match sub without target_owner costs one count per creation; the
            // owner prefilter keeps the rest cheap. Cap such subs if replays slow down again.
            return matchCreated({
              e,
              subs: subs().all(),
              pub,
              receipts,
              workers: o.trustedWorkers,
            });
          },
        };
      }
      case "ExpiryExtended": {
        targets.extend(k, e.expiresAt); // no-op unless watched
        const sub = subs().get(k);
        if (sub) subs().add({ ...sub, expiresAt: e.expiresAt }); // the subscription was renewed
        return {};
      }
      case "EntityPatched":
        return {
          later: changed(k, "patched", e.blockNumber),
          // A patched subscription: re-read it, so A and B never serve different fields (audit M1).
          rpc: subs().get(k) ? () => addSubscription(k) : undefined,
        };
      case "OwnershipTransferred":
        // The SDK decodes topics[2] = previous, topics[3] = new; the receipt pins the new owner.
        targets.transfer(k, e.newOwner);
        return { later: changed(k, "owner_changed", e.blockNumber) };
      case "EntityDeleted": {
        // Before the cache entry goes: the receipt needs the creator and owner it holds.
        const later = changed(k, "deleted", e.blockNumber);
        targets.delete(k);
        subs().remove(k);
        return { later };
      }
    }
  }

  return {
    // A block's events run concurrently (LLD §3.3), RPC at most 16 at a time across blocks; each is
    // filed under its block for settle(). Each phase retries on its own, and backoff sleeps never
    // hold a dispatch slot.
    onEvent(e: EntityEvent) {
      const what = `${e.type} ${e.entityKey}`;
      const step = apply(e);
      const done = (async () => {
        const fromRpc = step.rpc
          ? await retrying(what, () => limited(step.rpc!))
          : undefined;
        for (const later of [step.later, fromRpc])
          if (later) await retrying(`${what} receipts`, later);
      })();
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
