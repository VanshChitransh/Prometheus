import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toHex, type Hex } from "viem";
import { startHeartbeat } from "./heartbeat.ts";

const KEY = `0x${"c".repeat(64)}` as Hex;
const ADDRESS = `0x${"5".repeat(40)}` as Hex;

test("a refused extend on a still-live entity doesn't create a second worker entity", async () => {
  process.chdir(await mkdtemp(join(tmpdir(), "heartbeat-"))); // its state/ file lands here, not in the repo
  mock.timers.enable({ apis: ["setTimeout"] });
  const f = { creates: 0, extends: 0 };
  const writer = {
    create: async () => (f.creates++, { ok: true, value: { entityKey: KEY } }),
    extend: async () => (
      f.extends++,
      { ok: false, errorName: "InvalidOpType", reason: "refused" }
    ),
  };
  const pub = {
    request: async () => ({
      key: KEY,
      creator: ADDRESS,
      owner: ADDRESS,
      createdAt: toHex(1),
      expiresAt: toHex(10_000),
      attributes: [],
    }),
  };
  let stop = () => {};
  try {
    stop = await startHeartbeat(
      writer as never,
      pub as never,
      { delayBlocks: 0 } as never,
      ADDRESS,
    );
    assert.equal(f.creates, 1); // first boot: no key file yet
    mock.timers.tick(10 * 60_000);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(f.extends, 1);
    assert.equal(f.creates, 1); // still live, so no duplicate
  } finally {
    stop(); // even when an assertion fails: a live beat timer would keep the test process up
    mock.timers.reset();
  }
});
