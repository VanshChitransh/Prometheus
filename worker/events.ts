// The LLD §3.3 table: turns stream events into updates of the subscription index and the target
// cache, and tells the entrypoint when a block is fully handled so the checkpoint can pass it.
// Node only. change/new_match hooks arrive with T2.9 and T2.10.
import type {
  EntityCreatedEvent,
  EntityEvent,
  PublicArkivClient,
} from "@arkiv-network/sdk";
import type { Hex } from "viem";
import { freeCount, rawGetEntity } from "../shared/arkiv.ts";
import { PROJECT } from "../shared/schema.ts";
import { decodeSubscription } from "../shared/subscription.ts";
import type { Targets } from "./expiry.ts";
import type { SubsIndex } from "./subs.ts";

const MAX_IN_FLIGHT = 16;

export function createDispatch(o: {
  pub: PublicArkivClient;
  subs: () => SubsIndex; // a getter: the hourly re-sync swaps in a fresh index
  targets: Targets;
}) {
  const { pub, subs, targets } = o;
  const blocks = new Map<bigint, Promise<void>[]>();
  // A catch-up replays thousands of events at once; unbounded, each EntityCreated's free count hit
  // the node together and ~100 timed out (1,697-block replay, 16 Oct). Measured 17 Oct: 16 in flight
  // drains ~49 counts/s with no errors, so an hour of catch-up (~3,800 events) takes ~80 s.
  let active = 0;
  const waiting: (() => void)[] = [];
  async function limited(fn: () => Promise<void>) {
    while (active >= MAX_IN_FLIGHT)
      await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  async function created(e: EntityCreatedEvent) {
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

  async function handle(e: EntityEvent) {
    switch (e.type) {
      case "EntityCreated":
        return created(e);
      case "ExpiryExtended": {
        targets.extend(e.entityKey, e.expiresAt); // no-op unless watched
        const sub = subs().get(e.entityKey);
        if (sub) subs().add({ ...sub, expiresAt: e.expiresAt }); // the subscription was renewed
        return;
      }
      case "EntityDeleted":
        targets.delete(e.entityKey);
        subs().remove(e.entityKey);
        return;
      // EntityPatched, OwnershipTransferred: the `changed` triggers (T2.10).
    }
  }

  return {
    // A block's events run concurrently (LLD §3.3), at most 16 at a time across blocks; each is filed
    // under its block for settle().
    onEvent(e: EntityEvent) {
      // ponytail: a failed handler (e.g. an RPC timeout) is logged and the block still counts as
      // handled, so one bad call can't freeze the checkpoint; the hourly re-sync (T2.8) repairs
      // whatever it missed. Retry here if an hour of staleness ever matters.
      const done = limited(() => handle(e)).catch((err) =>
        console.error(`[events] ${e.type} ${e.entityKey} failed:`, err),
      );
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
