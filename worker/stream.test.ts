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
// makes the next getLogs throw.
function fake(logs: ReturnType<typeof logged>[] = []) {
  let release!: () => void;
  const f = {
    head: 105n,
    watches: 0,
    unwatches: 0,
    checkpoint: 100n, // follows onHead, like the worker's
    checkpointReads: 0,
    failLogs: false,
    replayGate: new Promise<void>((r) => (release = r)),
    release: () => release(),
    pushEvent: (_e: EntityEvent) => {},
    pushHead: (_n: bigint) => {},
    dropSocket: () => {},
    delivered: [] as string[],
    heads: [] as bigint[],
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
        return () => {};
      },
    } as never,
    http: {
      getBlockNumber: async () => f.head,
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        fromBlock: bigint;
        toBlock: bigint;
      }) => {
        await f.replayGate;
        if (f.failLogs) {
          f.failLogs = false;
          throw new Error("node down");
        }
        return logs.filter(
          (l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock,
        );
      },
    } as never,
    checkpoint: () => (f.checkpointReads++, f.checkpoint),
    onEvent: (e) =>
      f.delivered.push(`${e.transactionHash.slice(-1)}@${e.blockNumber}`),
    onHead: (n) => {
      f.heads.push(n);
      f.checkpoint = n - 1n;
    },
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

test("a failed catch-up retries after 5 s instead of buffering forever", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { f, stop } = fake();
    f.failLogs = true;
    f.release();
    await flush();
    f.pushHead(106n); // heads keep the stall timer quiet, so only the retry can recover
    assert.deepEqual(f.heads, []);
    mock.timers.tick(5_000);
    await flush();
    assert.equal(f.watches, 2);
    assert.deepEqual(f.heads, [106n]); // caught up on the retry
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
