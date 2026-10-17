import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import type { Receipt } from "../../shared/receipt.ts";
import type { Sub } from "../../shared/subscription.ts";
import {
  expiredGaps,
  groupByTrigger,
  rowStatus,
  summarize,
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

test("a duplicate A+B receipt is one row with two workers", () => {
  const rows = groupByTrigger([receipt(A, 10, 0), receipt(B, 10, 16)]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [...rows[0].late],
    [
      [A, 0n],
      [B, 16n],
    ],
  );
  assert.equal(rowStatus(rows[0], TRUSTED), "delivered twice");
});

test("rows are newest first and classed normal / covered by B", () => {
  const rows = groupByTrigger([receipt(A, 10, 1), receipt(B, 20, 15)]);
  assert.deepEqual(
    rows.map((r) => [r.triggerBlock, rowStatus(r, TRUSTED)]),
    [
      [20n, "covered by B"],
      [10n, "normal"],
    ],
  );
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

test("A offline after a failover: 'A offline · N covered by B'", () => {
  const rs = [
    receipt(A, 10, 0),
    receipt(B, 20, 15),
    receipt(B, 30, 17),
    receipt(A, 40, 0, { event: "keeper_low_funds" }),
  ];
  const rows = groupByTrigger(rs);
  const { headline, workers } = summarize(rs, rows, TRUSTED, [false, true]);
  assert.equal(headline, "A offline · 2 covered by B");
  assert.deepEqual(
    workers.map((w) => [w.name, w.delivered, w.only, w.medianLate, w.maxLate]),
    [
      ["A", 1, 1, 0n, 0n],
      ["B", 2, 2, 15n, 17n],
    ],
  );
  assert.equal(workers[0].lowFunds, true);
});

test("headline when all live, when B is down, and when none is", () => {
  const rs = [receipt(A, 10, 0), receipt(A, 20, 0), receipt(B, 20, 15)];
  const rows = groupByTrigger(rs);
  assert.equal(
    summarize(rs, rows, TRUSTED, [true, true]).headline,
    "All 2 workers live · 2 triggers in 24 h · 0 covered by failover · 1 delivered twice",
  );
  assert.equal(
    summarize(rs, rows, TRUSTED, [true, false]).headline,
    "B offline · no failover backup",
  );
  assert.equal(
    summarize(rs, rows, TRUSTED, [false, false]).headline,
    "No worker is live: nothing is being delivered",
  );
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
