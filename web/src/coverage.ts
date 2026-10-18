// Activity maths for #/coverage (T4.6): pure, no DOM, no network.
// Worker A fires; B waits delay_blocks and skips what A already did. Clients see one row per
// trigger whoever delivered it; the per-worker split is only for the operator section.
// Real gaps are triggers with no receipt at all.
import type { Hex } from "viem";
import type { Receipt } from "../../shared/receipt.ts";
import type { Event } from "../../shared/schema.ts";
import type { Sub } from "../../shared/subscription.ts";

export type TriggerRow = {
  triggerId: string;
  key: Hex; // the first receipt's: the on-chain proof a client can open
  event: Event; // the first receipt's; a keep's outcomes share one id
  subject: Hex;
  subscription: Hex;
  triggerBlock: bigint;
  late: Map<Hex, bigint | undefined>; // worker → done − trigger blocks (undefined: unknown)
};

export type WorkerStat = {
  address: Hex;
  name: string;
  live: boolean;
  delivered: number;
  only: number; // triggers no other worker delivered
  medianLate?: bigint;
  maxLate?: bigint;
  lowFunds: boolean;
};

// Trusted workers are named by their place in TRUSTED_WORKERS: A first (the primary), then B…
export const workerName = (i: number) => String.fromCharCode(65 + i);

// Per-worker conditions get their own id per worker by design (schema.md): not deliveries.
const isCondition = (r: Receipt) =>
  r.event === "keeper_low_funds" ||
  (r.event === "keep_skipped" && r.note === "budget");

export function groupByTrigger(receipts: readonly Receipt[]): TriggerRow[] {
  const rows = new Map<string, TriggerRow>();
  for (const r of receipts) {
    if (isCondition(r)) continue;
    let row = rows.get(r.triggerId);
    if (!row)
      rows.set(
        r.triggerId,
        (row = {
          triggerId: r.triggerId,
          key: r.key,
          event: r.event,
          subject: r.subject,
          subscription: r.subscription,
          triggerBlock: r.triggerBlock,
          late: new Map(),
        }),
      );
    row.late.set(
      r.creator,
      r.doneBlock === undefined ? undefined : r.doneBlock - r.triggerBlock,
    );
  }
  return [...rows.values()].sort((a, b) =>
    a.triggerBlock < b.triggerBlock ? 1 : -1,
  );
}

// Blocks until the first worker delivered it; undefined if no receipt says.
export function firstLate(row: TriggerRow) {
  const known = [...row.late.values()].filter((l) => l !== undefined);
  return known.length ? known.reduce((a, b) => (a < b ? a : b)) : undefined;
}

// The typical (median) delivery delay across rows, for the client's one-line summary.
export function typicalLate(rows: readonly TriggerRow[]) {
  const lates = rows
    .map(firstLate)
    .filter((l) => l !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return lates[Math.floor((lates.length - 1) / 2)];
}

// One entry per subscription, most recently active first (rows come newest first): the client
// reads "what happened to each thing I watch", not a raw event log.
export type SubActivity = {
  subscription: Hex;
  latest: TriggerRow;
  counts: Map<Event, number>;
};
export function bySubscription(rows: readonly TriggerRow[]) {
  const subs = new Map<string, SubActivity>();
  for (const r of rows) {
    const k = r.subscription.toLowerCase();
    let s = subs.get(k);
    if (!s)
      subs.set(
        k,
        (s = { subscription: r.subscription, latest: r, counts: new Map() }),
      );
    s.counts.set(r.event, (s.counts.get(r.event) ?? 0) + 1);
  }
  return [...subs.values()];
}

// Per-worker numbers for the operator section.
export function summarize(
  receipts: readonly Receipt[],
  rows: readonly TriggerRow[],
  trusted: readonly Hex[],
  live: readonly boolean[],
): WorkerStat[] {
  return trusted.map((address, i) => {
    const lates = rows
      .map((r) => r.late.get(address))
      .filter((l) => l !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      address,
      name: workerName(i),
      live: live[i],
      delivered: rows.filter((r) => r.late.has(address)).length,
      only: rows.filter((r) => r.late.size === 1 && r.late.has(address)).length,
      medianLate: lates[Math.floor((lates.length - 1) / 2)],
      maxLate: lates.at(-1),
      lowFunds: receipts.some(
        (r) => r.creator === address && r.event === "keeper_low_funds",
      ),
    };
  });
}

// `expired` subscriptions whose target is gone and has no trusted `expired` receipt.
export type ExpiredCheck = { sub: Sub; targetLive: boolean; receipts: number };
export const expiredGaps = (checks: readonly ExpiredCheck[]) =>
  checks.filter((c) => !c.targetLive && c.receipts === 0).map((c) => c.sub);
