import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import type { Sub } from "../shared/subscription.ts";
import { SubsIndex } from "./subs.ts";

const hex = (n: number, len = 64) =>
  `0x${n.toString(16).padStart(len, "0")}` as Hex;
const ALICE = hex(1, 40);

// `n` makes the key unique and, unless overridden, the creation block (bigger = newer).
const sub = (n: number, o: Partial<Sub> = {}): Sub => ({
  key: hex(n),
  creator: ALICE,
  createdAt: BigInt(n),
  expiresAt: 900_000n,
  publicMonitor: false,
  trigger: "expiring",
  label: `sub ${n}`,
  maxPerDay: 20,
  targetKey: hex(1000),
  leadBlocks: 30n,
  ...o,
});
const keys = (subs: Sub[]) => subs.map((s) => s.key).sort();

test("the reverse index stays consistent through add and remove", () => {
  const index = new SubsIndex();
  const [a, b, c] = [sub(1), sub(2), sub(3, { targetKey: hex(2000) })];
  for (const s of [a, b, c]) assert.ok(index.add(s).ok);
  assert.deepEqual(keys(index.forTarget(hex(1000))), keys([a, b]));
  assert.deepEqual(keys(index.forTarget(hex(2000))), keys([c]));

  assert.equal(index.remove(b.key), b);
  assert.deepEqual(keys(index.forTarget(hex(1000))), keys([a]));
  assert.deepEqual(keys(index.byCreator(ALICE)), keys([a, c]));
  index.remove(c.key);
  assert.deepEqual(index.forTarget(hex(2000)), []);
  assert.equal(index.size, 1);
  assert.equal(index.remove(c.key), undefined); // already gone
});

test("the cap drops a creator's 21st (newest) subscription", () => {
  const index = new SubsIndex();
  for (let n = 1; n <= 20; n++) assert.ok(index.add(sub(n)).ok);
  const r = index.add(sub(21));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /20-per-creator cap/);
  assert.equal(index.size, 20);
  assert.ok(index.add(sub(22, { creator: hex(2, 40) })).ok); // the cap is per creator
});

test("the cap keeps the 20 oldest whatever the arrival order", () => {
  const index = new SubsIndex();
  for (let n = 2; n <= 21; n++) index.add(sub(n));
  const r = index.add(sub(1)); // older than all 20 → in; the newest (21) is evicted
  assert.ok(r.ok);
  assert.equal(r.ok && r.evicted?.key, hex(21));
  assert.deepEqual(
    keys(index.byCreator(ALICE)),
    keys(Array.from({ length: 20 }, (_, i) => sub(i + 1))),
  );
});

test("the same subscription added twice replaces itself, not a cap slot", () => {
  const index = new SubsIndex();
  for (let n = 1; n <= 20; n++) index.add(sub(n));
  assert.ok(index.add(sub(5, { expiresAt: 999_999n })).ok);
  assert.equal(index.size, 20);
  assert.equal(
    index.forTarget(hex(1000)).find((s) => s.key === hex(5))?.expiresAt,
    999_999n,
  );
});

test("target lookups ignore key letter case", () => {
  const index = new SubsIndex();
  const target = `0x${"AB".repeat(32)}` as Hex;
  index.add(sub(1, { targetKey: target }));
  assert.equal(index.forTarget(target.toLowerCase() as Hex).length, 1);
  assert.equal(
    index.remove(hex(1).toUpperCase().replace("0X", "0x") as Hex)?.key,
    hex(1),
  );
});

test("a subscription re-added after a removal is no longer marked removed", () => {
  const i = new SubsIndex();
  const s = sub(1);
  i.add(s);
  i.remove(s.key); // e.g. patched invalid
  assert.equal(i.removed.has(s.key.toLowerCase() as Hex), true);
  i.add(s); // patched valid again
  assert.equal(i.removed.has(s.key.toLowerCase() as Hex), false); // the re-sync must keep it
});
