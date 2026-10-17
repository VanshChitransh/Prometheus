import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { EntityEvent } from "@arkiv-network/sdk";
import { startStream } from "./stream.ts";

const flush = () => new Promise((r) => setImmediate(r));
const key = (n: number) => `0x${String(n).padStart(64, "0")}` as const;

// A live event and the same event as eth_getLogs returns it.
const live = (tx: number, block: bigint) =>
  ({
    type: "EntityPatched",
    entityKey: key(tx),
    owner: `0x${"1".repeat(40)}`,
    blockNumber: block,
    transactionHash: key(tx),
    logIndex: 0,
  }) as EntityEvent;
const logged = (tx: number, block: bigint) => ({
  eventName: "EntityPatched",
  args: { entityKey: key(tx), owner: `0x${"1".repeat(40)}` },
  blockNumber: block,
  transactionHash: key(tx),
  logIndex: 0,
});

// Fake WebSocket streams and HTTP node. `replayGate` holds getLogs until released; `failLogs`
// makes the next getLogs throw. Like the real socket, a subscription's first head arrives just after
// subscribing (setImmediate) unless `autoHead` is off; `httpHeads` scripts the HTTP node's answers.
function fake(logs: ReturnType<typeof logged>[] = [], autoHead = true) {
  let release!: () => void;
  const f = {
    head: 105n,
    watches: 0,
    unwatches: 0,
    checkpoint: 100n, // follows onHead, like the worker's
    checkpointReads: 0,
    failLogs: 0, // how many getLogs calls fail next
    replayGate: new Promise<void>((r) => (release = r)),
    release: () => release(),
    pushEvent: (_e: EntityEvent) => {},
    pushHead: (_n: bigint) => {},
    dropSocket: () => {},
    delivered: [] as string[],
    heads: [] as bigint[],
    httpHeads: [] as bigint[],
    rawHeads: [] as bigint[],
    throwOnce: undefined as string | undefined, // the next delivery of this event throws
  };
  const stop = startStream({
    ws: {
      watchEntityEvents: ({
        onEvent,
        onError,
      }: {
        onEvent: (e: EntityEvent) => void;
        onError: (e: Error) => void;
      }) => {
        f.watches++;
        f.pushEvent = onEvent;
        f.dropSocket = () => onError(new Error("The socket has been closed."));
        return () => f.unwatches++;
      },
      watchBlockNumber: ({
        onBlockNumber,
      }: {
        onBlockNumber: (n: bigint) => void;
      }) => {
        f.pushHead = onBlockNumber;
        if (autoHead) setImmediate(() => onBlockNumber(f.head));
        return () => {};
      },
    } as never,
    http: {
      getBlockNumber: async () => f.httpHeads.shift() ?? f.head,
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        fromBlock: bigint;
        toBlock: bigint;
      }) => {
        await f.replayGate;
        if (f.failLogs > 0) {
          f.failLogs--;
          throw new Error("node down");
        }
        return logs.filter(
          (l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock,
        );
      },
    } as never,
    checkpoint: () => (f.checkpointReads++, f.checkpoint),
    onEvent: (e) => {
      const id = `${e.transactionHash.slice(-1)}@${e.blockNumber}`;
      if (f.throwOnce === id) {
        f.throwOnce = undefined;
        throw new Error("handler bug");
      }
      f.delivered.push(id);
    },
    onHead: (n) => {
      f.heads.push(n);
      f.checkpoint = n - 1n;
    },
    onRawHead: (n) => f.rawHeads.push(n),
  });
  return { f, stop };
}

test("replay, then the buffer, each event once; heads wait until caught up", async () => {
  const { f, stop } = fake([logged(1, 103n), logged(2, 105n)]);
  await flush();
  f.pushEvent(live(2, 105n)); // overlaps the replay
  f.pushEvent(live(3, 106n));
  f.pushHead(106n);
  assert.deepEqual(f.heads, []); // the checkpoint must not pass unreplayed blocks
  f.release();
  await flush();
  assert.deepEqual(f.delivered, ["1@103", "2@105", "3@106"]);
  assert.deepEqual(f.heads, [106n]);

  f.pushEvent(live(4, 107n)); // live now: straight through
  f.pushHead(107n);
  assert.deepEqual(f.delivered.at(-1), "4@107");
  assert.deepEqual(f.heads, [106n, 107n]);
  stop();
});

test("no head for 15 s → unwatch, resubscribe, replay from the checkpoint again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { f, stop } = fake();
    f.release();
    await flush();
    mock.timers.tick(14_999);
    assert.equal(f.watches, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(f.watches, 2);
    assert.equal(f.unwatches, 1);
    assert.equal(f.checkpointReads, 2);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("one failed getLogs is retried inside the catch-up; only a persistent one reconnects", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const once = fake();
    once.f.failLogs = 1;
    once.f.release();
    await flush();
    mock.timers.tick(1_000); // the chunk's first retry
    await flush();
    assert.equal(once.f.watches, 1); // same connect: the replay didn't restart
    assert.deepEqual(once.f.heads, [105n]);
    once.stop();

    const { f, stop } = fake();
    f.failLogs = 4; // 1 try + 3 retries all fail
    f.release();
    await flush();
    f.head = 106n;
    f.pushHead(106n); // heads keep the stall timer quiet, so only the retry can recover
    for (const ms of [1_000, 2_000, 4_000]) {
      mock.timers.tick(ms);
      await flush();
    }
    assert.deepEqual(f.heads, []); // still buffering: the checkpoint can't pass the hole
    mock.timers.tick(5_000); // catch-up failed → reconnect
    await flush();
    await flush();
    assert.equal(f.watches, 2);
    assert.deepEqual(f.heads, [106n]); // caught up on the reconnect
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("a socket error freezes the checkpoint and replays the gap viem doesn't backfill", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { f, stop } = fake([logged(5, 108n)]); // an event sent while the socket was down
    f.release();
    await flush();
    f.pushHead(106n); // live: checkpoint → 105
    f.dropSocket();
    f.head = 109n;
    f.pushHead(109n); // viem's restored subscription; block 108's event never arrives live
    assert.equal(f.checkpoint, 105n); // frozen: no head passes the hole
    mock.timers.tick(5_000);
    await flush();
    assert.deepEqual(f.delivered, ["5@108"]); // replayed 106 → 109
    assert.equal(f.heads.at(-1), 109n);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("the replay waits for the socket's first head, even when the HTTP node trails it", async () => {
  // The logs subscription isn't live until the socket's first head (viem subscribes asynchronously).
  // Meanwhile block 106 is produced, and its event never reaches the socket. Reading the HTTP head
  // first (105) and replaying only to it lost that event for good.
  const { f, stop } = fake([logged(7, 106n)], false);
  f.release();
  f.httpHeads.push(105n); // the HTTP node is a block behind at first
  await flush();
  f.head = 106n;
  f.pushHead(106n); // the subscription is live now: replay must reach at least 106
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(f.delivered, ["7@106"]);
  stop();
});

test("raw heads keep flowing while catching up (they drive the receipt flush)", async () => {
  const { f, stop } = fake([logged(1, 103n)]);
  await flush(); // the first head arrives; the replay is still held
  f.pushHead(106n);
  assert.deepEqual(f.heads, []); // the checkpoint waits for the replay...
  assert.deepEqual(f.rawHeads, [105n, 106n]); // ...the flush clock doesn't
  f.release();
  stop();
});

test("an event whose handler throws is replayed by the catch-up, not skipped as already seen", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const error = console.error;
  console.error = () => {}; // the failed catch-up is logged; keep test output clean
  try {
    const { f, stop } = fake([logged(3, 103n)]);
    f.throwOnce = "3@103";
    f.release();
    for (let i = 0; i < 5; i++) await flush();
    assert.deepEqual(f.delivered, []); // the handler threw: catch-up failed
    mock.timers.tick(5_000); // → reconnect and replay from the checkpoint
    for (let i = 0; i < 5; i++) await flush();
    assert.deepEqual(f.delivered, ["3@103"]);
    stop();
  } finally {
    console.error = error;
    mock.timers.reset();
  }
});
