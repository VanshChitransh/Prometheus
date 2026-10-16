import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerId } from "./triggerId.ts";

const base = {
  subscription: `0x${"a".repeat(64)}`,
  subject: `0x${"b".repeat(64)}`,
  event: "warned",
  triggerBlock: 643_450n,
} as const;

test("same input gives the same 32-byte id", () => {
  const id = triggerId(base);
  assert.equal(id, triggerId({ ...base }));
  assert.match(id, /^0x[0-9a-f]{64}$/);
});

test("changing any one field changes the id", () => {
  const variants = [
    { ...base, subscription: `0x${"c".repeat(64)}` },
    { ...base, subject: `0x${"c".repeat(64)}` },
    { ...base, event: "expired" },
    { ...base, triggerBlock: 643_451n },
  ] as const;
  const ids = new Set([base, ...variants].map(triggerId));
  assert.equal(ids.size, 5);
});

test("a re-extended target gives a new expiring id", () => {
  const lead = 30n;
  const before = triggerId({ ...base, triggerBlock: 1000n - lead });
  const after = triggerId({ ...base, triggerBlock: 2000n - lead });
  assert.notEqual(before, after);
});

test("key letter case doesn't matter", () => {
  const mixed = `0x${"A".repeat(64)}` as const;
  assert.equal(
    triggerId({ ...base, subscription: mixed }),
    triggerId({ ...base, subscription: `0x${"a".repeat(64)}` }),
  );
});

test("a malformed key or block throws instead of hashing", () => {
  assert.throws(() => triggerId({ ...base, subject: `0x${"b".repeat(62)}` }));
  assert.throws(() => triggerId({ ...base, triggerBlock: -1n }));
  assert.throws(() => triggerId({ ...base, triggerBlock: 2n ** 64n }));
});
