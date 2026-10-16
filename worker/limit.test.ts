import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter, inBatches } from "./limit.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("the limiter caps concurrency and starts tasks in arrival order", async () => {
  const limited = createLimiter(3);
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      limited(async () => {
        started.push(i);
        peak = Math.max(peak, ++active);
        await tick();
        active--;
      }),
    ),
  );
  assert.equal(peak, 3);
  assert.deepEqual(
    started,
    Array.from({ length: 20 }, (_, i) => i),
  ); // FIFO: no queue-jumping
});

test("a task that throws still frees its slot", async () => {
  const limited = createLimiter(1);
  await assert.rejects(
    limited(async () => {
      throw new Error("x");
    }),
  );
  assert.equal(await limited(async () => "next"), "next");
});

test("inBatches keeps order and caps concurrency", async () => {
  let active = 0;
  let peak = 0;
  const out = await inBatches(
    [1, 2, 3, 4, 5],
    async (n) => {
      peak = Math.max(peak, ++active);
      await tick();
      active--;
      return n * 10;
    },
    2,
  );
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});
