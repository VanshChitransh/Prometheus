import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntityEvent } from "@arkiv-network/sdk";
import { toHex, type Hex } from "viem";
import { parseSearch } from "../shared/searchAst.ts";
import type { Sub } from "../shared/subscription.ts";
import { createDispatch } from "./events.ts";
import { Targets } from "./expiry.ts";
import { SubsIndex } from "./subs.ts";

// No new_match subscriptions here: matching is covered in match.test.ts.
const NO_FIRE = { receipts: { fire: async () => {} }, trustedWorkers: [] };

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
  const fired: {
    sub: Hex;
    subject: Hex;
    event: string;
    block: bigint;
    seen?: unknown;
  }[] = [];
  const d = createDispatch({
    pub: pub as never,
    subs: () => subs,
    targets,
    receipts: {
      fire: async (sub, subject, event, block, seen) => {
        fired.push({ sub: sub.key, subject, event, block, seen });
      },
    },
    trustedWorkers: [],
  });
  const run = async (e: Partial<EntityEvent>) => {
    d.onEvent({
      blockNumber: 10n,
      transactionHash: hex(9),
      logIndex: 0,
      ...e,
    } as EntityEvent);
    await d.settle(10n);
  };
  return { subs, targets, f, d, run, fired };
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

// T2.10: a `changed` subscription on TARGET next to WATCHER (an `expiring` one, which must stay quiet).
function changeSetup() {
  const s = setup();
  s.subs.add({
    ...WATCHER,
    key: hex(3),
    trigger: "changed",
    leadBlocks: undefined,
  });
  s.targets.set(TARGET, {
    expiresAt: 4_000n,
    creator: OWNER,
    owner: OWNER,
    flags: { readonly: false, permissionlessExtension: false },
  });
  return s;
}

test("EntityPatched of a watched target → patched, at the log's block, for changed subs only", async () => {
  const { fired, f, run } = changeSetup();
  await run({ type: "EntityPatched", entityKey: TARGET, owner: OWNER });
  assert.deepEqual(fired, [
    {
      sub: hex(3),
      subject: TARGET,
      event: "patched",
      block: 10n,
      seen: { creator: OWNER, owner: OWNER },
    },
  ]);
  assert.equal(f.counts + f.reads, 0); // no RPC
});

test("OwnershipTransferred → owner_changed, and the cache and receipt carry the new owner", async () => {
  const { fired, targets, run } = changeSetup();
  const NEW = hex(8, 40);
  await run({
    type: "OwnershipTransferred",
    entityKey: TARGET,
    previousOwner: OWNER,
    newOwner: NEW,
  });
  assert.equal(targets.get(TARGET)?.owner, NEW);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.event, "owner_changed");
  assert.deepEqual(fired[0]!.seen, { creator: OWNER, owner: NEW });
});

test("EntityDeleted of a watched target → deleted with the cached owner, then off the cache", async () => {
  const { fired, targets, run } = changeSetup();
  await run({ type: "EntityDeleted", entityKey: TARGET, owner: OWNER });
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.event, "deleted");
  assert.deepEqual(fired[0]!.seen, { creator: OWNER, owner: OWNER });
  assert.equal(targets.get(TARGET), undefined);
});

test("a change to an unwatched entity fires nothing", async () => {
  const { fired, run } = changeSetup();
  await run({ type: "EntityPatched", entityKey: OTHER, owner: OWNER });
  await run({ type: "EntityDeleted", entityKey: OTHER, owner: OWNER });
  assert.equal(fired.length, 0);
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
    ...NO_FIRE,
  });
  broken.onEvent({
    ...created(OTHER),
    blockNumber: 11n,
    transactionHash: hex(9),
    logIndex: 1,
  } as EntityEvent);
  await broken.settle(11n);
});

test("a replay burst is capped at 16 requests in flight, and every event still gets handled", async () => {
  let active = 0;
  let peak = 0;
  let handled = 0;
  const pub = {
    request: async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      handled++;
      return 0; // not a subscription
    },
  };
  const d = createDispatch({
    pub: pub as never,
    subs: () => new SubsIndex(),
    targets: new Targets(),
    ...NO_FIRE,
  });
  for (let i = 0; i < 50; i++)
    d.onEvent({
      ...created(hex(5000 + i)),
      blockNumber: 10n,
      transactionHash: hex(9),
      logIndex: i,
    } as EntityEvent);
  await d.settle(10n);
  assert.equal(handled, 50);
  assert.equal(peak, 16);
});

test("a match's fire waits outside the limiter, and its block still settles only after it", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r)); // worker B's delay_blocks wait
  let fires = 0;
  const subs = new SubsIndex();
  subs.add({
    ...WATCHER,
    key: hex(2),
    trigger: "new_match",
    targetKey: undefined,
    leadBlocks: undefined,
    search: parseSearch({ eq: ["kind", { str: "x" }] }),
  });
  const d = createDispatch({
    pub: {
      request: async ({ params }: { params: [{ query: string }] }) =>
        params[0].query.includes("'subscription'") ? 0 : 1, // everything matches
    } as never,
    subs: () => subs,
    targets: new Targets(),
    receipts: {
      fire: async () => {
        fires++;
        await held;
      },
    },
    trustedWorkers: [],
  });
  const event = (i: number, blockNumber: bigint) =>
    d.onEvent({
      ...created(hex(5000 + i)),
      blockNumber,
      transactionHash: hex(9),
      logIndex: i,
    } as EntityEvent);
  for (let i = 0; i < 17; i++) event(i, 10n); // one more than the limiter's 16 slots
  let settled = false;
  const s = d.settle(10n).then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fires, 17); // the 17th got a slot although 16 fires are still waiting
  assert.equal(settled, false); // but the checkpoint can't pass an unrecorded match
  release();
  await s;
});
