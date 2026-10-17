import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import type { Receipt } from "../../shared/receipt.ts";
import type { Sub } from "../../shared/subscription.ts";
import {
  expiredGaps,
  firstLate,
  groupByTrigger,
  summarize,
  typicalLate,
} from "./coverage.ts";

const A: Hex = "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B";
const B: Hex = "0xa70C8245582d173b04cAe453E9fF6D17a6e58294";
const TRUSTED = [A, B];
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

let n = 0;
const receipt = (
  creator: Hex,
  trigger: number,
  late: number,
  o: Partial<Receipt> = {},
): Receipt => ({
  key: id(++n) as Hex,
  creator,
  triggerId: id(1000 + trigger),
  subscription: id(2000) as Hex,
  subject: id(3000) as Hex,
  event: "warned",
  triggerBlock: BigInt(trigger),
  doneBlock: BigInt(trigger + late),
  ...o,
});

test("a duplicate A+B receipt is one row with two workers, linked to the first receipt", () => {
  const a = receipt(A, 10, 0);
  const rows = groupByTrigger([a, receipt(B, 10, 16)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [...rows[0].late],
    [
      [A, 0n],
      [B, 16n],
    ],
  );
  assert.equal(rows[0].key, a.key);
  assert.equal(firstLate(rows[0]), 0n);
});

test("rows are newest first; the typical delay is the median first delivery", () => {
  const rows = groupByTrigger([
    receipt(A, 10, 1),
    receipt(B, 20, 15),
    receipt(A, 30, 3),
    receipt(B, 30, 18),
  ]);
  assert.deepEqual(
    rows.map((r) => r.triggerBlock),
    [30n, 20n, 10n],
  );
  assert.equal(typicalLate(rows), 3n);
  assert.equal(typicalLate([]), undefined);
});

test("per-worker conditions are not deliveries", () => {
  const rows = groupByTrigger([
    receipt(A, 10, 0, { event: "keeper_low_funds" }),
    receipt(B, 11, 0, { event: "keep_skipped", note: "budget" }),
    receipt(A, 12, 0, { event: "keep_skipped", note: "deny_listed" }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.triggerBlock),
    [12n],
  );
});

test("per-worker stats: deliveries, sole deliveries, lateness, low funds", () => {
  const rs = [
    receipt(A, 10, 0),
    receipt(B, 20, 15),
    receipt(B, 30, 17),
    receipt(A, 40, 0, { event: "keeper_low_funds" }),
  ];
  const workers = summarize(rs, groupByTrigger(rs), TRUSTED, [false, true]);
  assert.deepEqual(
    workers.map((w) => [
      w.name,
      w.live,
      w.delivered,
      w.only,
      w.medianLate,
      w.maxLate,
    ]),
    [
      ["A", false, 1, 1, 0n, 0n],
      ["B", true, 2, 2, 15n, 17n],
    ],
  );
  assert.equal(workers[0].lowFunds, true);
});

test("a gap is a gone target with no expired receipt", () => {
  const sub = (label: string) => ({ label }) as Sub;
  const gaps = expiredGaps([
    { sub: sub("gone, no receipt"), targetLive: false, receipts: 0 },
    { sub: sub("gone, receipted"), targetLive: false, receipts: 1 },
    { sub: sub("still live"), targetLive: true, receipts: 0 },
  ]);
  assert.deepEqual(
    gaps.map((s) => s.label),
    ["gone, no receipt"],
  );
});
