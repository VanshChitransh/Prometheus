import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidParamsRpcError } from "viem";
import { RpcError } from "./arkiv.ts";
import {
  isLogCapacityError,
  loadCheckpoint,
  replayEntityRanges,
  saveCheckpoint,
  SeenLogs,
  smallerLogSpan,
} from "./replay.ts";

// A node that refuses spans over 500 blocks and has one log per block.
function fakeNode(maxSpan = 500n) {
  const calls: [bigint, bigint][] = [];
  const getLogs = async (from: bigint, to: bigint) => {
    if (to - from + 1n > maxSpan)
      throw new RpcError("eth_getLogs", -32602, { cause: "too wide" });
    calls.push([from, to]);
    const logs: bigint[] = [];
    for (let b = from; b <= to; b++) logs.push(b);
    return logs;
  };
  return { getLogs, calls };
}

test("replay halves past the capacity error and covers every block exactly once", async () => {
  const node = fakeNode();
  const seen: bigint[] = [];
  await replayEntityRanges(100n, 2_444n, node.getLogs, (b) => seen.push(b));
  assert.equal(seen.length, 2_345);
  seen.forEach((b, i) => assert.equal(b, 100n + BigInt(i))); // in order, no gaps or repeats
  assert.ok(node.calls.every(([f, t]) => t - f + 1n <= 500n));
});

test("chunk edges: one block, an exact 1,000-block span, and an empty range", async () => {
  for (const [from, to, n] of [
    [7n, 7n, 1],
    [0n, 999n, 1_000],
    [5n, 4n, 0],
  ] as const) {
    const node = fakeNode(1_000n);
    const seen: bigint[] = [];
    await replayEntityRanges(from, to, node.getLogs, (b) => seen.push(b));
    assert.equal(seen.length, n);
    assert.ok(node.calls.length <= 1);
  }
});

test("other errors are rethrown, not halved", async () => {
  const err = new RpcError("eth_getLogs", 429, { cause: "rate limited" });
  let calls = 0;
  await assert.rejects(
    replayEntityRanges(
      0n,
      10n,
      async () => (calls++, Promise.reject(err)),
      () => {},
    ),
    err,
  );
  assert.equal(calls, 1);
});

test("a capacity error at span 1 is rethrown instead of looping forever", async () => {
  const always = async () => {
    throw new RpcError("eth_getLogs", -32602, { cause: "x" });
  };
  await assert.rejects(
    replayEntityRanges(0n, 0n, always, () => {}),
    RpcError,
  );
});

test("capacity error is matched by code, including inside a viem error", () => {
  assert.ok(
    isLogCapacityError(
      new InvalidParamsRpcError(
        new Error("query exceeds max block range 100000"),
      ),
    ),
  );
  assert.ok(isLogCapacityError(new RpcError("eth_getLogs", 413, { cause: 0 })));
  assert.ok(!isLogCapacityError(new Error("query exceeds max block range"))); // text alone isn't enough
  assert.equal(smallerLogSpan(1_000n), 500n);
  assert.equal(smallerLogSpan(1n), 1n);
});

test("SeenLogs skips repeats and evicts the oldest past its bound", () => {
  const seen = new SeenLogs(3);
  const log = (i: number) => ({ transactionHash: `0x${i}`, logIndex: 0 });
  assert.equal(seen.add(log(1)), true);
  assert.equal(seen.add(log(1)), false);
  assert.equal(seen.add({ transactionHash: "0x1", logIndex: 1 }), true); // same tx, other log
  seen.add(log(2));
  seen.add(log(3)); // size 4 > 3 → 0x1:0 evicted
  assert.equal(seen.add(log(1)), true);
  assert.equal(seen.add(log(3)), false);
});

test("checkpoint round-trips, is undefined when missing, and throws when corrupt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prometheus-"));
  const path = join(dir, "checkpoint.json");
  assert.equal(await loadCheckpoint(path), undefined);
  await saveCheckpoint(path, 645_000n);
  assert.equal(await loadCheckpoint(path), 645_000n);
  await saveCheckpoint(path, 645_100n);
  assert.equal(await loadCheckpoint(path), 645_100n);
  await writeFile(path, "{not json");
  await assert.rejects(loadCheckpoint(path));
});
