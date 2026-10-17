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
const NO_FIRE = {
  receipts: { fire: async () => "done" as const },
  trustedWorkers: [],
  retryBaseMs: 1,
};

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

function setup(
  o: { watched?: boolean; slow?: Promise<void>; discoveredAt?: bigint } = {},
) {
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
        return "done" as const;
      },
    },
    trustedWorkers: [],
    discoveredAt: o.discoveredAt,
  });
  const run = async (e: Partial<EntityEvent>) => {
    d.onEvent({
      blockNumber: 10n,
      transactionHash: hex(9),
      logIndex: 0,
      ...e,
    } as EntityEvent);
    await d.settle(e.blockNumber ?? 10n);
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
        return "done" as const;
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

test("a handler that fails is retried, and its block doesn't settle until it succeeds", async () => {
  const subs = new SubsIndex();
  let failures = 2;
  const pub = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params: unknown[];
    }) => {
      if (method === "arkiv_getEntityCount") {
        if (failures-- > 0) throw new Error("timeout"); // the "is it a subscription?" count
        return 1;
      }
      return rpcSub(NEW_SUB, "new");
    },
  };
  const d = createDispatch({
    ...NO_FIRE,
    pub: pub as never,
    subs: () => subs,
    targets: new Targets(),
  });
  d.onEvent({
    ...created(NEW_SUB),
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent);
  await d.settle(10n);
  assert.ok(subs.get(NEW_SUB)); // not lost: the third attempt indexed it
});

test("a change receipt whose fire fails is retried until it's done (never offered again)", async () => {
  const subs = new SubsIndex();
  subs.add({ ...WATCHER, trigger: "changed", leadBlocks: undefined });
  let calls = 0;
  const d = createDispatch({
    ...NO_FIRE,
    pub: { request: async () => 0 } as never,
    subs: () => subs,
    targets: new Targets(),
    receipts: { fire: async () => (++calls < 3 ? "failed" : "done") },
  });
  d.onEvent({
    type: "EntityPatched",
    entityKey: TARGET,
    owner: OWNER,
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent);
  await d.settle(10n);
  assert.equal(calls, 3);
});

test("a persistent failure is dropped after the attempt cap, so the worker can't freeze", async () => {
  let attempts = 0;
  const d = createDispatch({
    ...NO_FIRE,
    pub: {
      request: async () => {
        attempts++;
        throw new Error("rpc down");
      },
    } as never,
    subs: () => new SubsIndex(),
    targets: new Targets(),
  });
  d.onEvent({
    ...created(OTHER),
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent);
  await d.settle(10n);
  assert.equal(attempts, 10);
});

test("a replayed created + extended for one target, arriving together, end at the extension (H3)", async () => {
  const subs = new SubsIndex();
  subs.add(WATCHER);
  const targets = new Targets();
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r)); // the "is it a subscription?" count is slow
  const d = createDispatch({
    ...NO_FIRE,
    pub: { request: async () => (await slow, 0) } as never,
    subs: () => subs,
    targets,
  });
  const ev = (e: Partial<EntityEvent>, i: number) =>
    ({
      blockNumber: 10n,
      transactionHash: hex(9),
      logIndex: i,
      ...e,
    }) as EntityEvent;
  d.onEvent(ev(created(TARGET, 4_000n), 0));
  d.onEvent(
    ev(
      {
        type: "ExpiryExtended",
        entityKey: TARGET,
        owner: OWNER,
        expiresAt: 6_000n,
      },
      1,
    ),
  );
  release();
  await d.settle(10n);
  assert.equal(targets.get(TARGET)?.expiresAt, 6_000n); // not reset to the creation-time 4,000
});

test("a replayed created + deleted leaves no cache entry, so no false `expired` (H3)", async () => {
  const subs = new SubsIndex();
  subs.add(WATCHER);
  const targets = new Targets();
  const d = createDispatch({
    ...NO_FIRE,
    pub: { request: async () => 0 } as never,
    subs: () => subs,
    targets,
  });
  d.onEvent({
    ...created(TARGET),
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent);
  d.onEvent({
    type: "EntityDeleted",
    entityKey: TARGET,
    owner: OWNER,
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 1,
  } as EntityEvent);
  await d.settle(10n);
  assert.equal(targets.get(TARGET), undefined);
});

test("a replayed created never resurrects a target already cached as gone (H3)", async () => {
  const subs = new SubsIndex();
  subs.add(WATCHER);
  const targets = new Targets();
  targets.set(TARGET, {
    expiresAt: 3_000n,
    creator: OWNER,
    owner: OWNER,
    flags: { readonly: false, permissionlessExtension: false },
  });
  targets.markGone(TARGET); // seeded at startup: expired while we were down
  const d = createDispatch({
    ...NO_FIRE,
    pub: { request: async () => 0 } as never,
    subs: () => subs,
    targets,
  });
  await (d.onEvent({
    ...created(TARGET),
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent),
  d.settle(10n));
  assert.equal(targets.get(TARGET)?.gone, true);
});

// A node whose subscription entity can be rewritten (a patch) between reads.
function patchable(sub: ReturnType<typeof rpcSub> | null) {
  const node = { sub, targetAlive: true };
  const pub = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params: unknown[];
    }) => {
      if (method === "arkiv_getEntityCount") return 0;
      if (params[0] === NEW_SUB) return node.sub;
      return node.targetAlive ? rpcTarget : null;
    },
  };
  return { node, pub: pub as never };
}
const patched = (k: Hex) =>
  ({
    type: "EntityPatched",
    entityKey: k,
    owner: OWNER,
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  }) as EntityEvent;

test("a patched subscription is re-read, so its new fields take effect now (M1)", async () => {
  const subs = new SubsIndex();
  subs.add({ ...WATCHER, key: NEW_SUB, leadBlocks: 30n }); // being served, lead 30
  const { node, pub } = patchable(rpcSub(NEW_SUB, "new"));
  node.sub = {
    ...rpcSub(NEW_SUB, "new"),
    attributes: rpcSub(NEW_SUB).attributes.map((a) =>
      a.name === "lead_blocks" ? { ...a, value: "600" } : a,
    ),
  }; // the owner patched lead_blocks to 600
  const d = createDispatch({
    ...NO_FIRE,
    pub,
    subs: () => subs,
    targets: new Targets(),
  });
  d.onEvent(patched(NEW_SUB));
  await d.settle(10n);
  assert.equal(subs.get(NEW_SUB)?.leadBlocks, 600n); // A and B now agree on the trigger block
});

test("a patch that makes a subscription invalid removes it (M1)", async () => {
  const subs = new SubsIndex();
  const { node, pub } = patchable(rpcSub(NEW_SUB, "new"));
  const d = createDispatch({
    ...NO_FIRE,
    pub,
    subs: () => subs,
    targets: new Targets(),
  });
  subs.add({ ...WATCHER, key: NEW_SUB });
  node.sub = rpcSub(NEW_SUB); // the label is gone: invalid now
  d.onEvent(patched(NEW_SUB));
  await d.settle(10n);
  assert.equal(subs.get(NEW_SUB), undefined);
});

test("a new expiring subscription on a target that doesn't exist is rejected (LLD §3.8)", async () => {
  const subs = new SubsIndex();
  const pub = {
    request: async ({
      method,
      params,
    }: {
      method: string;
      params: unknown[];
    }) =>
      method === "arkiv_getEntityCount"
        ? 1
        : params[0] === NEW_SUB
          ? rpcSub(NEW_SUB, "new")
          : null,
  };
  const d = createDispatch({
    ...NO_FIRE,
    pub: pub as never,
    subs: () => subs,
    targets: new Targets(),
  });
  d.onEvent({
    ...created(NEW_SUB),
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent);
  await d.settle(10n);
  assert.equal(subs.get(NEW_SUB), undefined);
});

test("counts wait until the HTTP node has the event's block (M7)", async () => {
  const subs = new SubsIndex();
  const heads = [9n, 9n, 10n]; // the HTTP node trails the socket by a block, then catches up
  let headAtCount = 0n;
  let head = 0n;
  const d = createDispatch({
    ...NO_FIRE,
    pub: { request: async () => ((headAtCount = head), 0) } as never,
    subs: () => subs,
    targets: new Targets(),
    headNow: async () => (head = heads.shift() ?? 10n),
  });
  d.onEvent({
    ...created(OTHER),
    blockNumber: 10n,
    transactionHash: hex(9),
    logIndex: 0,
  } as EntityEvent);
  await d.settle(10n);
  assert.equal(headAtCount, 10n); // counted only once the HTTP node had block 10
});

// --- M1: a catch-up replay must not pay one free count per chain-wide creation ---
// Startup discovery already indexed every live subscription as of its block, so a creation at or
// before that block is either indexed already or gone: counting it again can't add anything.

test("a creation at or before the discovery block costs no subscription count", async () => {
  const { run, f, subs } = setup({ discoveredAt: 10n });
  await run({ ...created(OTHER), blockNumber: 9n });
  await run({ ...created(NEW_SUB), blockNumber: 10n });
  assert.equal(f.counts, 0);
  assert.equal(subs.get(NEW_SUB), undefined); // discovery owns these
});

test("a creation after the discovery block is still counted and added", async () => {
  const { run, f, subs } = setup({ discoveredAt: 10n });
  await run({ ...created(NEW_SUB), blockNumber: 11n });
  assert.equal(f.counts, 1);
  assert.equal(subs.get(NEW_SUB)?.label, "new");
});

test("an already indexed subscription costs no count, whatever its block", async () => {
  const { run, f, subs } = setup({ discoveredAt: 10n });
  subs.add({ ...WATCHER, key: NEW_SUB, label: "known" });
  await run({ ...created(NEW_SUB), blockNumber: 50n });
  assert.equal(f.counts, 0);
  assert.equal(subs.get(NEW_SUB)?.label, "known");
});

test("new_match still sees creations replayed from before the discovery block", async () => {
  const { run, f, subs, fired } = setup({ discoveredAt: 10n, watched: false });
  subs.add({
    ...WATCHER,
    key: hex(5),
    trigger: "new_match",
    targetKey: undefined,
    leadBlocks: undefined,
    targetOwner: OWNER,
    search: parseSearch({ eq: ["kind", { str: "x" }] }),
  });
  await run({ ...created(NEW_SUB), blockNumber: 9n }); // the fake count says 1 for NEW_SUB
  assert.equal(f.counts, 1); // the match count only, no subscription count
  assert.deepEqual(
    fired.map((x) => [x.event, x.subject]),
    [["matched", NEW_SUB]],
  );
});
