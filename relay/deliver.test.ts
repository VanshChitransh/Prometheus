import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityEvent, PublicArkivClient } from "@arkiv-network/sdk";
import { toHex, type Hex } from "viem";
import { openDb } from "./db.ts";
import {
  createHandler,
  createSendQueue,
  formatReceipt,
  startDelivery,
  type Receipt,
} from "./deliver.ts";

const A: Hex = "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B";
const B: Hex = "0xa70C8245582d173b04cAe453E9fF6D17a6e58294";
const STRANGER: Hex = `0x${"9".repeat(40)}`;
const TRUSTED = [A, B];
const SUB: Hex = `0x${"a".repeat(64)}`;
const TARGET: Hex = `0x${"c".repeat(64)}`;
const TRIGGER: Hex = `0x${"d".repeat(64)}`;
const k = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

// --- the handler, against a stubbed node and an in-memory DB ---

// The node's raw arkiv_getEntity shape (lowercase creator; rawGetEntity checksums it).
const rpcEntity = (
  key: Hex,
  creator: Hex,
  attrs: Record<string, string>,
  payload: unknown,
) => ({
  key,
  creator: creator.toLowerCase(),
  owner: creator.toLowerCase(),
  createdAt: "0x1",
  expiresAt: "0x99999",
  attributes: Object.entries(attrs).map(([name, value]) => ({
    name,
    type: name === "trigger_block" ? "u64" : "string",
    value,
  })),
  payload: toHex(JSON.stringify(payload)),
});

const receiptRpc = (key: Hex, creator: Hex, kind = "receipt") =>
  rpcEntity(
    key,
    creator,
    {
      project: "prometheus",
      kind,
      trigger_id: TRIGGER,
      subscription: SUB,
      subject: TARGET,
      event: "expired",
      trigger_block: "643450",
    },
    { v: 1 },
  );

// head: the HTTP node's head (omitted = no lag check); hidden: keys the HTTP node can't see yet.
function setup({ head, hidden = [] }: { head?: bigint; hidden?: Hex[] } = {}) {
  const entities = new Map<string, unknown>([
    [k(1), receiptRpc(k(1), A)],
    [k(2), receiptRpc(k(2), B)], // worker B's copy of the same trigger
    [k(3), receiptRpc(k(3), A, "worker")], // a heartbeat
    [
      SUB,
      rpcEntity(
        SUB,
        STRANGER,
        {
          project: "prometheus",
          kind: "subscription",
          trigger: "expired",
          target_key: TARGET,
        },
        { v: 1, label: "Lapse canary" },
      ),
    ],
  ]);
  const lookups: unknown[] = [];
  const client = {
    request: async ({ params }: { params: [string] }) => {
      lookups.push(params[0]);
      if (hidden.includes(params[0] as Hex)) return null;
      return entities.get(params[0]) ?? null;
    },
  } as unknown as PublicArkivClient;
  const db = openDb(":memory:");
  db.follow(1, SUB);
  db.follow(2, SUB);
  const sent: [number, string][] = [];
  const handle = createHandler({
    client,
    db,
    trusted: TRUSTED,
    enqueue: (chat, text) => sent.push([chat, text]),
    headNow: head === undefined ? undefined : async () => head,
  });
  return { handle, sent, lookups };
}

const created = (entityKey: Hex, owner: Hex, logIndex = 0): EntityEvent =>
  ({
    type: "EntityCreated",
    entityKey,
    owner,
    expiresAt: 999n,
    creationFlags: { readonly: true, permissionlessExtension: false },
    blockNumber: 10n,
    transactionHash: `0x${"e".repeat(64)}`,
    logIndex,
  }) as EntityEvent;

test("receipts from both workers for one trigger DM each follower once", async () => {
  const { handle, sent } = setup();
  await handle(created(k(1), A));
  await handle(created(k(2), B));
  await handle(created(k(1), A)); // a replay after a restart
  assert.deepEqual(
    sent.map(([chat]) => chat),
    [1, 2],
  );
  assert.match(sent[0]![1], /🔴 EXPIRED · Lapse canary/);
});

test("a heartbeat or a stranger's entity sends nothing; a stranger costs no lookup", async () => {
  const { handle, sent, lookups } = setup();
  await handle(created(k(3), A));
  await handle(created(k(1), STRANGER));
  assert.deepEqual(sent, []);
  assert.deepEqual(lookups, [k(3)]);
});

// --- the send queue, on a fake clock ---

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

test("one chat gets at most one message per second", async () => {
  const clock = fakeClock();
  const at: number[] = [];
  const q = createSendQueue({
    ...clock,
    send: async () => at.push(clock.now()),
  });
  for (let i = 0; i < 30; i++) q.push(1, `m${i}`);
  await q.idle();
  assert.equal(at.length, 30);
  assert.ok(at.at(-1)! >= 29_000);
});

test("30 different chats are only spaced by the global limit", async () => {
  const clock = fakeClock();
  const at: number[] = [];
  const q = createSendQueue({
    ...clock,
    send: async () => at.push(clock.now()),
  });
  for (let chat = 1; chat <= 30; chat++) q.push(chat, "m");
  await q.idle();
  assert.equal(at.length, 30);
  assert.ok(at.at(-1)! < 2_000); // 29 × 40 ms
});

test("a busy chat doesn't hold up another chat, and per-chat order is kept", async () => {
  const clock = fakeClock();
  const sent: string[] = [];
  const q = createSendQueue({
    ...clock,
    send: async (chat, text) => sent.push(`${chat}:${text}`),
  });
  q.push(1, "a");
  q.push(1, "b");
  q.push(2, "c");
  await q.idle();
  assert.deepEqual(sent, ["1:a", "2:c", "1:b"]);
});

test("a 429 waits retry_after and resends; a 403 is dropped", async () => {
  const clock = fakeClock();
  const at: [number, string][] = [];
  let flooded = true;
  const q = createSendQueue({
    ...clock,
    send: async (chat, text) => {
      if (chat === 9) throw { error_code: 403 };
      if (flooded) {
        flooded = false;
        throw { error_code: 429, parameters: { retry_after: 3 } };
      }
      at.push([clock.now(), text]);
    },
  });
  const log = console.error;
  console.error = () => {}; // the drop is logged; keep test output clean
  try {
    q.push(1, "hi");
    q.push(9, "blocked");
    await q.idle();
  } finally {
    console.error = log;
  }
  assert.deepEqual(
    at.map(([, text]) => text),
    ["hi"],
  );
  assert.ok(at[0]![0] >= 3_000); // not before retry_after, for any chat
  assert.equal(q.size, 0);
});

// --- message format ---

const base: Receipt = {
  key: k(1),
  creator: A,
  triggerId: TRIGGER,
  subscription: SUB,
  subject: TARGET,
  event: "expired",
  triggerBlock: 643_450n,
  tx: `0x${"e".repeat(64)}`,
};

test("expired says 'not renewed by block X' and links receipt, target and tx", () => {
  const text = formatReceipt(base, "Lapse canary for example.org");
  assert.match(text, /^🔴 EXPIRED · Lapse canary for example\.org\n/);
  assert.match(text, /Not renewed by block 643450\./);
  assert.match(text, new RegExp(`/entity/${TARGET}`));
  assert.match(text, new RegExp(`/entity/${k(1)}`));
  assert.match(text, /\/tx\/0xe{64}/);
});

test("keep_skipped includes the reason", () => {
  const text = formatReceipt(
    { ...base, event: "keep_skipped", note: "already_extended" },
    "x",
  );
  assert.match(text, /RENEWAL SKIPPED/);
  assert.match(text, /Reason: already extended\./);
});

test("no message ever asks for a wallet or a signature", () => {
  for (const event of [
    "warned",
    "expired",
    "patched",
    "owner_changed",
    "deleted",
    "matched",
    "kept",
    "keep_skipped",
    "keep_failed",
  ] as const)
    assert.doesNotMatch(
      formatReceipt({ ...base, event }, "label"),
      /wallet|sign|connect/i,
    );
});

// --- M5: the HTTP node can trail the socket that delivered the event ---

test("a receipt the HTTP node hasn't reached yet throws, so the event is retried", async () => {
  const behind = setup({ head: 9n, hidden: [k(1)] }); // event is at block 10
  await assert.rejects(behind.handle(created(k(1), A)), /behind/);
  assert.deepEqual(behind.sent, []);

  const caughtUp = setup({ head: 10n }); // the retry, once the node has the block
  await caughtUp.handle(created(k(1), A));
  assert.equal(caughtUp.sent.length, 2);
});

test("a receipt that's null on a caught-up node is really gone: skipped quietly", async () => {
  const { handle, sent } = setup({ head: 10n, hidden: [k(1)] });
  await handle(created(k(1), A));
  assert.deepEqual(sent, []);
});

// --- M3: a network blip or a Telegram 5xx must not drop the DM ---

const quiet = async (fn: () => Promise<void>) => {
  const log = console.error;
  console.error = () => {}; // drops are logged; keep test output clean
  try {
    await fn();
  } finally {
    console.error = log;
  }
};

test("transient send errors back off 1, 2, 4, 8, 16 s and then deliver", async () => {
  const clock = fakeClock();
  const tries: number[] = [];
  const q = createSendQueue({
    ...clock,
    send: async () => {
      tries.push(clock.now());
      if (tries.length <= 5) throw new Error("fetch failed"); // grammY HttpError: no error_code
    },
  });
  q.push(1, "hi");
  await q.idle();
  assert.deepEqual(tries, [0, 1_000, 3_000, 7_000, 15_000, 31_000]);
  assert.equal(q.size, 0);
});

test("another chat isn't held up while one chat backs off", async () => {
  const clock = fakeClock();
  const sent: string[] = [];
  let fails = 3;
  const q = createSendQueue({
    ...clock,
    send: async (chat) => {
      if (chat === 1 && fails-- > 0) throw new Error("fetch failed");
      sent.push(`${chat}@${clock.now()}`);
    },
  });
  q.push(1, "a");
  q.push(2, "b");
  await q.idle();
  assert.equal(sent[0], "2@40"); // right after chat 1's first failure
  assert.equal(sent.at(-1), "1@7000");
});

test("a DM is dropped only after 10 failed tries; a 400 after one", async () => {
  const clock = fakeClock();
  let tries = 0;
  const q = createSendQueue({
    ...clock,
    send: async (chat) => {
      tries++;
      throw chat === 9 ? { error_code: 400 } : new Error("fetch failed");
    },
  });
  await quiet(async () => {
    q.push(9, "bad chat");
    await q.idle();
    assert.equal(tries, 1);
    q.push(1, "never lands");
    await q.idle();
  });
  assert.equal(tries, 11);
  assert.equal(q.size, 0);
});

// --- M2: stopping must never move the checkpoint past an event that wasn't handled ---

test("stop() mid-retry leaves the checkpoint before the unhandled event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deliver-"));
  const file = join(dir, "checkpoint.json");
  writeFileSync(file, JSON.stringify({ block: "100" }));
  let onEvent!: (e: EntityEvent) => void;
  let onHead!: (n: bigint) => void;
  const ws = {
    watchEntityEvents: (o: { onEvent: typeof onEvent }) => (
      (onEvent = o.onEvent),
      () => {}
    ),
    watchBlockNumber: (o: { onBlockNumber: typeof onHead }) => (
      (onHead = o.onBlockNumber),
      () => {}
    ),
  };
  const http = {
    getBlockNumber: async () => 101n,
    getLogs: async () => [],
    request: async () => {
      throw new Error("node down"); // every receipt lookup fails, so the event keeps retrying
    },
  } as unknown as PublicArkivClient;
  try {
    await quiet(async () => {
      const stop = await startDelivery({
        ws: ws as never,
        http,
        db: openDb(":memory:"),
        trusted: TRUSTED,
        checkpointFile: file,
        send: async () => {},
      });
      onHead(101n); // first head: the catch-up runs and goes live
      await new Promise((r) => setTimeout(r, 50));
      onEvent({ ...created(k(1), A), blockNumber: 102n } as EntityEvent);
      onHead(104n); // would save 103, past the unhandled event at 102
      await new Promise((r) => setTimeout(r, 50));
      await stop();
    });
    const saved = BigInt(JSON.parse(readFileSync(file, "utf8")).block);
    assert.ok(saved < 102n, `checkpoint ${saved} passed the unhandled event`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- RL-7: a graceful stop (a redeploy) sends the DMs already queued before the DB closes ---

test("stop() waits for queued DMs to go out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deliver-"));
  let onEvent!: (e: EntityEvent) => void;
  let onHead!: (n: bigint) => void;
  const ws = {
    watchEntityEvents: (o: { onEvent: typeof onEvent }) => (
      (onEvent = o.onEvent),
      () => {}
    ),
    watchBlockNumber: (o: { onBlockNumber: typeof onHead }) => (
      (onHead = o.onBlockNumber),
      () => {}
    ),
  };
  const entities = new Map<string, unknown>([
    [k(1), receiptRpc(k(1), A)],
    [
      SUB,
      rpcEntity(
        SUB,
        STRANGER,
        { project: "prometheus", kind: "subscription", trigger: "expired" },
        { v: 1, label: "Lapse canary" },
      ),
    ],
  ]);
  const http = {
    getBlockNumber: async () => 101n,
    getLogs: async () => [],
    request: async ({ params }: { params: [string] }) =>
      entities.get(params[0]) ?? null,
  } as unknown as PublicArkivClient;
  const db = openDb(":memory:");
  db.follow(1, SUB);
  const sent: number[] = [];
  try {
    const stop = await startDelivery({
      ws: ws as never,
      http,
      db,
      trusted: TRUSTED,
      checkpointFile: join(dir, "checkpoint.json"),
      send: async (chat) => {
        await new Promise((r) => setTimeout(r, 30)); // Telegram's round trip
        sent.push(chat);
      },
    });
    onHead(101n); // the catch-up runs and goes live
    await new Promise((r) => setTimeout(r, 50));
    onEvent({ ...created(k(1), A), blockNumber: 101n } as EntityEvent);
    await new Promise((r) => setTimeout(r, 10)); // handled and queued; the send is in flight
    await stop(); // SIGTERM now
    assert.deepEqual(sent, [1]);
  } finally {
    // Only what this test wrote: the checkpoint, then its folder.
    const file = join(dir, "checkpoint.json");
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
  }
});
