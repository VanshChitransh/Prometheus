// What memory loses on a restart, and what drifts over hours (LLD §3.1, §3.2): seeding targets
// (including ones that expired while we were down), today's per-subscription counts, and the hourly
// re-sync. Node only. `fired` isn't rebuilt: after a restart each repeat trigger costs fire() one
// free count, finds its receipt and marks itself, which is the same result without paid queries.
import {
  decodeCreationFlags,
  ENTITY_EVENTS_ABI,
  type PublicArkivClient,
} from "@arkiv-network/sdk";
import { decodeEventLog, encodeEventTopics, numberToHex, type Hex } from "viem";
import { freeCount, trustedFilter } from "../shared/arkiv.ts";
import { PROJECT } from "../shared/schema.ts";
import type { Target, Targets } from "./expiry.ts";
import { inBatches } from "./limit.ts";
import type { Receipts } from "./receipts.ts";
import { discoverAll, type SubsIndex } from "./subs.ts";

const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044"; // not exported by SDK 0.8.1
// How far back a target that's gone at startup is looked up. ponytail: past a day, `expired` isn't
// written for it (it's just counted as unknown); raise this if workers can be down that long.
const EXPIRED_LOOKBACK_BLOCKS = 43_200n; // 24 h of 2 s blocks
const HOUR_MS = 60 * 60_000;

// Every log of these three events for one entity: topic 0 = which event, topic 1 = entityKey (indexed).
const TOPIC0 = (
  ["EntityCreated", "ExpiryExtended", "EntityDeleted"] as const
).map(
  (eventName) => encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName })[0],
);

type Seen = Omit<Target, "gone">;

// `head − ⌊(now − UTC midnight) / 2 s⌋`: today's first block, assuming 2 s blocks. It may drift a
// few blocks, which is fine for a soft daily cap (LLD §3.1).
export function dayStartBlock(head: bigint, now: Date) {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return head - BigInt(Math.floor((now.getTime() - midnight) / 2_000));
}

// A gone target's last known expiry, from its own logs over the last day: the same block the live
// monitor would have used, so A and B (and any receipt written before a crash) agree on trigger_id.
// undefined = deleted (not an expiry), or no record in the window.
// ponytail: one getLogs call over a day; chunk it if the node starts refusing that range.
export async function lastExpiry(
  pub: PublicArkivClient,
  key: Hex,
  head: bigint,
): Promise<Seen | undefined> {
  const request = pub.request as unknown as (a: {
    method: "eth_getLogs";
    params: unknown[];
  }) => Promise<{ topics: [Hex, ...Hex[]]; data: Hex }[]>;
  const logs = await request({
    method: "eth_getLogs",
    params: [
      {
        address: ARKIV_ADDRESS,
        topics: [TOPIC0, key.toLowerCase()],
        fromBlock: numberToHex(
          head > EXPIRED_LOOKBACK_BLOCKS ? head - EXPIRED_LOOKBACK_BLOCKS : 0n,
        ),
        toBlock: numberToHex(head),
      },
    ],
  });
  let seen: Seen | undefined;
  let creator: Hex | undefined;
  for (const log of logs) {
    // Logs come in chain order, so the last one decides.
    const e = decodeEventLog({ abi: ENTITY_EVENTS_ABI, ...log });
    if (e.eventName === "EntityDeleted") seen = undefined;
    else if (e.eventName === "EntityCreated") {
      creator = e.args.owner;
      const { readonly, permissionlessExtension } = decodeCreationFlags(
        e.args.creationFlags,
      );
      seen = {
        expiresAt: e.args.expiresAt,
        creator,
        owner: e.args.owner,
        flags: { readonly, permissionlessExtension },
      };
    } else if (e.eventName === "ExpiryExtended")
      seen = {
        expiresAt: e.args.expiresAt,
        creator: creator ?? e.args.owner, // created before the window: the owner is our best guess
        owner: e.args.owner,
        flags: seen?.flags ?? {
          readonly: false,
          permissionlessExtension: false,
        },
      };
  }
  return seen && seen.expiresAt <= head ? seen : undefined;
}

// LLD §3.2 step 3, also run by the hourly re-sync: one free read per distinct target. Live → cached
// (a re-read fixes drifted expiries). Gone → cached as gone at its real expiry block, so the monitor
// fires `expired`; a target already known to be gone isn't looked up again.
export async function seedTargets(
  pub: PublicArkivClient,
  subs: SubsIndex,
  targets: Targets,
  head: bigint,
) {
  const watched = new Set(
    subs
      .all()
      .flatMap((s) => (s.targetKey ? [s.targetKey.toLowerCase() as Hex] : [])),
  );
  let gone = 0;
  let unknown = 0;
  await inBatches([...watched], async (k) => {
    if (targets.get(k)?.gone || (await targets.seed(pub, k))) return;
    const last = await lastExpiry(pub, k, head).catch((e) => {
      console.error(`[startup] looking up ${k}'s last expiry failed:`, e);
      return undefined;
    });
    if (!last) return unknown++;
    targets.set(k, last);
    targets.markGone(k);
    gone++;
  });
  // LLD §3.8: expiring, changed and keep need a live target; only `expired` may watch one that
  // already lapsed (that's what it's for). The rest can never fire usefully again.
  let rejected = 0;
  for (const s of subs.all()) {
    const t = s.targetKey && targets.get(s.targetKey);
    if (s.targetKey && s.trigger !== "expired" && (!t || t.gone)) {
      subs.remove(s.key);
      rejected++;
    }
  }
  console.log(
    `[startup] ${watched.size} targets: ${watched.size - gone - unknown} live, ${gone} expired while away, ${unknown} gone with no expiry in the last day; ${rejected} subscriptions dropped (target not live)`,
  );
}

// LLD §3.1: today's trusted receipts per subscription (schema query #3, free), so a restart doesn't
// reset max_per_day. Added to the unsent ones resume() counted from the pending file.
// ponytail: a soft cap, so two drifts are accepted: a trigger both workers wrote (a failover race)
// counts twice, erring toward fewer alerts; and the day is decided by trigger_block, while live
// counting uses the day the worker acted. Exact would need distinct trigger_ids: a paid query.
export async function rebuildDayCounts(
  pub: PublicArkivClient,
  subs: SubsIndex,
  receipts: Pick<Receipts, "seedDayCount">,
  head: bigint,
  trustedWorkers: Hex[],
) {
  const from = dayStartBlock(head, new Date());
  const trusted = trustedFilter(trustedWorkers);
  let total = 0;
  await inBatches(subs.all(), async (s) => {
    const n = await freeCount(
      pub,
      `project = str('${PROJECT}') AND kind = str('receipt') AND subscription = key(${s.key}) AND trigger_block >= u64(${from}) AND ${trusted}`,
    );
    if (n > 0) receipts.seedDayCount(s.key, n);
    total += n;
  });
  console.log(`[startup] ${total} receipts so far today (since block ${from})`);
}

// Pure. The fresh index is the truth as of `block`; an old subscription missing from it is kept only
// if it was created after `block` (live dispatch added it while the query ran). One created before
// and missing now has expired or been deleted, which emits no event for natural expiry: drop it.
// Keys deleted live since the last re-sync are dropped from `fresh` too: discovery may have read one
// just before its deletion.
export function mergeResync(old: SubsIndex, fresh: SubsIndex, block: bigint) {
  for (const k of old.removed) fresh.remove(k);
  fresh.removed.clear();
  let kept = 0;
  for (const s of old.all())
    if (!fresh.get(s.key) && s.createdAt > block && fresh.add(s).ok) kept++;
  const added = fresh.all().filter((s) => !old.get(s.key)).length;
  const dropped = old.all().filter((s) => !fresh.get(s.key)).length;
  return { subs: fresh, added, dropped, kept };
}

// LLD §3.2 step 6: every hour, re-discover subscriptions and re-seed targets. A failure is logged and
// the old state stays; the next hour retries. Returns a function that stops it.
export function startResync(o: {
  pub: PublicArkivClient;
  subs: () => SubsIndex;
  setSubs: (subs: SubsIndex) => void;
  targets: Targets;
}) {
  let running = false;
  const resync = async () => {
    if (running) return;
    running = true;
    try {
      const { subs: fresh, block } = await discoverAll(o.pub);
      // No await between merge and swap: a live event can't land in the old index in between.
      const r = mergeResync(o.subs(), fresh, block);
      o.setSubs(r.subs);
      console.log(
        `[resync] ${r.subs.size} subscriptions (+${r.added} −${r.dropped}, ${r.kept} kept from live events)`,
      );
      await seedTargets(o.pub, r.subs, o.targets, await o.pub.getBlockNumber());
    } catch (e) {
      console.error("[resync] failed; keeping the current state:", e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void resync(), HOUR_MS);
  timer.unref(); // never the reason the process stays up
  return () => clearInterval(timer);
}
