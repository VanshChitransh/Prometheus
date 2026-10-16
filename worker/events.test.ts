import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntityEvent } from "@arkiv-network/sdk";
import { toHex, type Hex } from "viem";
import type { Sub } from "../shared/subscription.ts";
import { createDispatch } from "./events.ts";
import { Targets } from "./expiry.ts";
import { SubsIndex } from "./subs.ts";

const hex = (n: number, len = 64) =>
  `0x${n.toString(16).padStart(len, "0")}` as Hex;
const OWNER = hex(7, 40);
const TARGET = hex(1000); // watched by WATCHER
const NEW_SUB = hex(2000); // a subscription entity that appears on chain
const BAD_SUB = hex(2001); // a subscription entity without a label
const OTHER = hex(3000); // nobody cares
const WATCHER: Sub = {
  key: hex(1),
  creator: OWNER,
  createdAt: 1n,
  expiresAt: 900_000n,
  publicMonitor: false,
  trigger: "expiring",
  label: "watcher",
  maxPerDay: 20,
  targetKey: TARGET,
  leadBlocks: 30n,
};

// A subscription as the node's raw arkiv_getEntity returns it.
const rpcSub = (key: Hex, label?: string) => ({
  key,
  creator: OWNER,
  owner: OWNER,
  createdAt: toHex(5),
  expiresAt: toHex(800_000),
  attributes: [
    { name: "project", type: "str", value: "prometheus" },
    { name: "kind", type: "str", value: "subscription" },
    { name: "trigger", type: "str", value: "expiring" },
    { name: "target_key", type: "key", value: TARGET },
    { name: "lead_blocks", type: "u64", value: "30" },
  ],
  payload: toHex(JSON.stringify({ v: 1, label })),
});
const rpcTarget = {
  key: TARGET,
  creator: OWNER,
  owner: OWNER,
  createdAt: toHex(1),
  expiresAt: toHex(5_000),
  attributes: [],
};

function setup(o: { watched?: boolean; slow?: Promise<void> } = {}) {
  const subs = new SubsIndex();
  if (o.watched !== false) subs.add(WATCHER);
  const targets = new Targets();
  const f = { counts: 0, reads: 0 };
  const entities: Record<string, unknown> = {
    [NEW_SUB]: rpcSub(NEW_SUB, "new"),
    [BAD_SUB]: rpcSub(BAD_SUB),
    [TARGET]: rpcTarget,
  };
  const pub = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params: unknown[];
    }) => {
      await o.slow;
      if (method === "arkiv_getEntityCount") {
        f.counts++;
        const k = (params[0] as { query: string }).query.match(
          /key\((0x\w+)\)/,
        )![1]!;
        return [NEW_SUB, BAD_SUB].includes(k as Hex) ? 1 : 0;
      }
      f.reads++;
      return entities[params[0] as string] ?? null;
    },
  };
  const d = createDispatch({ pub: pub as never, subs: () => subs, targets });
  const run = async (e: Partial<EntityEvent>) => {
    d.onEvent({
      blockNumber: 10n,
      transactionHash: hex(9),
      logIndex: 0,
      ...e,
    } as EntityEvent);
    await d.settle(10n);
  };
  return { subs, targets, f, d, run };
}
const created = (entityKey: Hex, expiresAt = 4_000n) =>
  ({
    type: "EntityCreated",
    entityKey,
    owner: OWNER,
    expiresAt,
    creationFlags: { readonly: false, permissionlessExtension: true, raw: 2 },
  }) as Partial<EntityEvent>;

test("EntityCreated of a valid subscription → indexed, and its target seeded", async () => {
  const { subs, targets, run } = setup({ watched: false });
  await run(created(NEW_SUB));
  assert.equal(subs.get(NEW_SUB)?.label, "new");
  assert.equal(targets.get(TARGET)?.expiresAt, 5_000n);
});

test("EntityCreated of an invalid subscription → not indexed", async () => {
  const { subs, run } = setup({ watched: false });
  await run(created(BAD_SUB));
  assert.equal(subs.size, 0);
});

test("EntityCreated of a watched target → cached from the event, no read", async () => {
  const { targets, f, run } = setup();
  await run(created(TARGET, 4_000n));
  assert.deepEqual(targets.get(TARGET), {
    expiresAt: 4_000n,
    creator: OWNER,
    owner: OWNER,
    flags: { readonly: false, permissionlessExtension: true },
    gone: false,
  });
  assert.equal(f.reads, 0);
});

test("EntityCreated of an unrelated entity → one free count, nothing else", async () => {
  const { subs, targets, f, run } = setup();
  await run(created(OTHER));
  assert.equal(f.counts, 1);
  assert.equal(f.reads, 0);
  assert.equal(targets.size, 0);
  assert.equal(subs.size, 1);
});

test("ExpiryExtended → the watched target's cache, or the subscription's own expiry", async () => {
  const { subs, targets, run } = setup();
  await run(created(TARGET, 4_000n));
  await run({
    type: "ExpiryExtended",
    entityKey: TARGET,
    owner: OWNER,
    expiresAt: 6_000n,
  });
  assert.equal(targets.get(TARGET)?.expiresAt, 6_000n);
  await run({
    type: "ExpiryExtended",
    entityKey: WATCHER.key,
    owner: OWNER,
    expiresAt: 950_000n,
  });
  assert.equal(subs.get(WATCHER.key)?.expiresAt, 950_000n);
});

test("EntityDeleted → off the schedule, and a deleted subscription is dropped", async () => {
  const { subs, targets, run } = setup();
  await run(created(TARGET));
  await run({ type: "EntityDeleted", entityKey: TARGET, owner: OWNER });
  assert.equal(targets.get(TARGET), undefined);
  await run({ type: "EntityDeleted", entityKey: WATCHER.key, owner: OWNER });
  assert.equal(subs.size, 0);
});

test("EntityPatched and OwnershipTransferred change nothing yet (T2.10)", async () => {
  const { subs, f, run } = setup();
  await run({ type: "EntityPatched", entityKey: TARGET, owner: OWNER });
  await run({
    type: "OwnershipTransferred",
    entityKey: TARGET,
    previousOwner: OWNER,
    newOwner: hex(8, 40),
  });
  assert.equal(subs.size, 1);
  assert.equal(f.counts + f.reads, 0);
});

test("settle() waits for every handler in the block; a failing one doesn't block it", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const { subs, d } = setup({ watched: false, slow });
  d.onEvent({
    ...created(NEW_SUB),
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent);
  let settled = false;
  const s = d.settle(10n).then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false); // block 10 isn't done: the checkpoint must wait
  release();
  await s;
  assert.ok(subs.get(NEW_SUB));

  // A handler that throws (the node is down) is logged; the next block still settles.
  const broken = createDispatch({
    pub: {
      request: async () => {
        throw new Error("rpc down");
      },
    } as never,
    subs: () => subs,
    targets: new Targets(),
  });
  broken.onEvent({
    ...created(OTHER),
    blockNumber: 11n,
    transactionHash: hex(9),
    logIndex: 1,
  } as EntityEvent);
  await broken.settle(11n);
});
