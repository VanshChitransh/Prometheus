// Coverage maths for #/coverage (T4.6): pure, no DOM, no network.
// Worker A fires; B waits delay_blocks and skips what A already did. So a normal trigger has one
// receipt (A's), a B-only trigger is a failover ("covered by B"), and A+B is a harmless race.
// Real gaps are triggers with no receipt at all.
import type { Hex } from "viem";
import type { Receipt } from "../../shared/receipt.ts";
import type { Event } from "../../shared/schema.ts";
import type { Sub } from "../../shared/subscription.ts";

export type TriggerRow = {
  triggerId: string;
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

// "normal" | "covered by B" | "delivered twice", for one row.
export function rowStatus(row: TriggerRow, trusted: readonly Hex[]) {
  if (row.late.size > 1) return "delivered twice";
  if (row.late.has(trusted[0])) return "normal";
  const by = trusted.findIndex((a) => row.late.has(a));
  return `covered by ${workerName(by)}`;
}

export function summarize(
  receipts: readonly Receipt[],
  rows: readonly TriggerRow[],
  trusted: readonly Hex[],
  live: readonly boolean[],
) {
  const workers: WorkerStat[] = trusted.map((address, i) => {
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

  const twice = rows.filter((r) => r.late.size > 1).length;
  const covered = rows.filter((r) => !r.late.has(trusted[0])).length;
  const [primary, ...backups] = workers;
  let headline: string;
  if (workers.every((w) => !w.live))
    headline = "No worker is live: nothing is being delivered";
  else if (workers.every((w) => w.live))
    headline = `All ${workers.length} workers live · ${rows.length} triggers in 24 h · ${covered} covered by failover · ${twice} delivered twice`;
  else {
    const parts: string[] = [];
    if (!primary.live) {
      const by = backups.filter((w) => w.only > 0).map((w) => w.name);
      parts.push(
        `${primary.name} offline · ${covered} covered by ${by.join(" and ") || "no one yet"}`,
      );
    }
    for (const w of backups)
      if (!w.live) parts.push(`${w.name} offline · no failover backup`);
    headline = parts.join(" · ");
  }
  return { workers, headline };
}

// `expired` subscriptions whose target is gone and has no trusted `expired` receipt.
export type ExpiredCheck = { sub: Sub; targetLive: boolean; receipts: number };
export const expiredGaps = (checks: readonly ExpiredCheck[]) =>
  checks.filter((c) => !c.targetLive && c.receipts === 0).map((c) => c.sub);
