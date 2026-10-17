import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntityEvent, PublicArkivClient } from "@arkiv-network/sdk";
import { toHex, type Hex } from "viem";
import type { RawEntity } from "../shared/arkiv.ts";
import { openDb } from "./db.ts";
import {
  createHandler,
  createSendQueue,
  formatReceipt,
  parseReceipt,
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

const receiptAttrs = (over: Record<string, unknown> = {}) => ({
  project: "prometheus",
  kind: "receipt",
  trigger_id: TRIGGER,
  subscription: SUB,
  subject: TARGET,
  event: "expired",
  trigger_block: 643_450n,
  ...over,
});

const raw = (
  creator: Hex,
  attributes: Record<string, unknown>,
  payload?: unknown,
): RawEntity => ({
  key: k(1),
  creator,
  owner: creator,
  createdAt: 1n,
  expiresAt: 999n,
  flags: { readonly: true, permissionlessExtension: false },
  attributes: attributes as RawEntity["attributes"],
  payload: payload === undefined ? undefined : toHex(JSON.stringify(payload)),
});

test("parseReceipt trusts only a worker-created prometheus receipt", () => {
  const r = parseReceipt(raw(A, receiptAttrs(), { v: 1 }), TRUSTED);
  assert.equal(r?.triggerId, TRIGGER);
  assert.equal(r?.triggerBlock, 643_450n);
  assert.equal(parseReceipt(raw(STRANGER, receiptAttrs()), TRUSTED), null);
  assert.equal(
    parseReceipt(raw(A, receiptAttrs({ kind: "worker" })), TRUSTED),
    null,
  );
  assert.equal(
    parseReceipt(raw(A, receiptAttrs({ project: "other" })), TRUSTED),
    null,
  );
  assert.equal(
    parseReceipt(raw(A, receiptAttrs({ trigger_block: "1" })), TRUSTED),
    null,
  );
});

test("parseReceipt reads the note and survives a broken payload", () => {
  const note = parseReceipt(
    raw(A, receiptAttrs({ event: "keep_skipped" }), {
      v: 1,
      note: "deny_listed",
    }),
    TRUSTED,
  );
  assert.equal(note?.note, "deny_listed");
  const broken = { ...raw(A, receiptAttrs()), payload: toHex("not json") };
  assert.equal(parseReceipt(broken, TRUSTED)?.note, undefined);
});

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

function setup() {
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
