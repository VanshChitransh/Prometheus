import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTITY_EVENTS_ABI } from "@arkiv-network/sdk";
import {
  encodeAbiParameters,
  encodeEventTopics,
  hexToBigInt,
  toHex,
  type Hex,
} from "viem";
import type { Sub } from "../shared/subscription.ts";
import { Targets } from "./expiry.ts";
import {
  dayStartBlock,
  lastExpiry,
  mergeResync,
  rebuildDayCounts,
  seedTargets,
} from "./startup.ts";
import { SubsIndex } from "./subs.ts";

const hex = (n: number, len = 64) =>
  `0x${n.toString(16).padStart(len, "0")}` as Hex;
const OWNER = hex(7, 40);
const TRUSTED = hex(5, 40);
const sub = (n: number, o: Partial<Sub> = {}): Sub => ({
  key: hex(n),
  creator: hex(1, 40),
  createdAt: BigInt(n),
  expiresAt: 900_000n,
  publicMonitor: false,
  trigger: "expired",
  label: `sub ${n}`,
  maxPerDay: 20,
  targetKey: hex(1000 + n),
  ...o,
});
const index = (...subs: Sub[]) => {
  const i = new SubsIndex();
  for (const s of subs) i.add(s);
  return i;
};

// Real encoded logs, as eth_getLogs returns them.
const created = (key: Hex, expiresAt: bigint, creationFlags = 2) => ({
  topics: encodeEventTopics({
    abi: ENTITY_EVENTS_ABI,
    eventName: "EntityCreated",
    args: { entityKey: key, owner: OWNER },
  }),
  data: encodeAbiParameters(
    [{ type: "uint64" }, { type: "uint8" }],
    [expiresAt, creationFlags],
  ),
});
const extended = (key: Hex, expiresAt: bigint) => ({
  topics: encodeEventTopics({
    abi: ENTITY_EVENTS_ABI,
    eventName: "ExpiryExtended",
    args: { entityKey: key, owner: OWNER },
  }),
  data: encodeAbiParameters([{ type: "uint64" }], [expiresAt]),
});
const deleted = (key: Hex) => ({
  topics: encodeEventTopics({
    abi: ENTITY_EVENTS_ABI,
    eventName: "EntityDeleted",
    args: { entityKey: key, owner: OWNER },
  }),
  data: "0x" as Hex,
});

// A fake node: `alive` answers arkiv_getEntity, `logs` answers eth_getLogs, `counts` the free count.
function node(o: {
  alive?: Record<string, bigint>;
  logs?: Record<string, ReturnType<typeof created>[]>;
  counts?: Record<string, number>;
}) {
  const calls: { method: string; params: any[] }[] = [];
  const pub = {
    request: async ({ method, params }: { method: string; params: any[] }) => {
      calls.push({ method, params });
      if (method === "eth_getLogs") return o.logs?.[params[0].topics[1]] ?? [];
      if (method === "arkiv_getEntityCount") {
        const k = params[0].query.match(/subscription = key\((0x\w+)\)/)[1];
        return o.counts?.[k] ?? 0;
      }
      const exp = o.alive?.[params[0]];
      return exp === undefined
        ? null
        : {
            key: params[0],
            creator: OWNER,
            owner: OWNER,
            createdAt: toHex(1),
            expiresAt: toHex(exp),
            attributes: [],
          };
    },
  };
  return { pub: pub as never, calls };
}

test("dayStartBlock counts back from UTC midnight in 2 s blocks", () => {
  assert.equal(dayStartBlock(1_000n, new Date("2026-10-17T00:00:00Z")), 1_000n);
  assert.equal(dayStartBlock(1_000n, new Date("2026-10-17T00:00:11Z")), 995n);
  assert.equal(
    dayStartBlock(100_000n, new Date("2026-10-17T12:00:00Z")),
    78_400n,
  );
});

test("mergeResync drops what's gone, keeps what live events added since the snapshot", () => {
  const old = index(sub(10), sub(20), sub(50)); // 20: expired; 50: created after the snapshot
  const fresh = index(sub(10), sub(30)); // the query saw block 40
  const r = mergeResync(old, fresh, 40n);
  assert.deepEqual(
    r.subs
      .all()
      .map((s) => s.createdAt)
      .sort(),
    [10n, 30n, 50n],
  );
  assert.deepEqual(
    { added: r.added, dropped: r.dropped, kept: r.kept },
    { added: 1, dropped: 1, kept: 1 },
  );
});

test("lastExpiry returns the newest expiry from the entity's own logs", async () => {
  const k = hex(1001);
  const { pub, calls } = node({
    logs: { [k]: [created(k, 500n), extended(k, 800n), extended(k, 900n)] },
  });
  assert.deepEqual(await lastExpiry(pub, k, 50_000n), {
    expiresAt: 900n,
    creator: OWNER,
    owner: OWNER,
    flags: { readonly: false, permissionlessExtension: true },
  });
  const p = calls[0]!.params[0];
  assert.equal(p.topics[1], k); // filtered to this one entity
  assert.equal(hexToBigInt(p.fromBlock), 50_000n - 43_200n); // the last day
});

test("lastExpiry: deleted, no logs, or an expiry still ahead → undefined", async () => {
  const k = hex(1001);
  const at = (logs: ReturnType<typeof created>[]) =>
    lastExpiry(node({ logs: { [k]: logs } }).pub, k, 1_000n);
  assert.equal(await at([created(k, 500n), deleted(k)]), undefined); // deleted isn't expired
  assert.equal(await at([]), undefined);
  assert.equal(await at([created(k, 5_000n)]), undefined); // gone before its expiry: deleted
});

test("seedTargets: live → cached; expired while away → gone at its real block; unknown → skipped", async () => {
  const [live, away, unknown] = [sub(1), sub(2), sub(3)];
  const { pub } = node({
    alive: { [live.targetKey!]: 9_000n },
    logs: { [away.targetKey!]: [created(away.targetKey!, 700n)] },
  });
  const targets = new Targets();
  await seedTargets(pub, index(live, away, unknown), targets, 1_000n);
  assert.equal(targets.get(live.targetKey!)?.expiresAt, 9_000n);
  assert.deepEqual(
    [
      targets.get(away.targetKey!)?.expiresAt,
      targets.get(away.targetKey!)?.gone,
    ],
    [700n, true],
  );
  assert.equal(targets.get(unknown.targetKey!), undefined);
});

test("rebuildDayCounts seeds today's trusted receipts per subscription", async () => {
  const [busy, quiet] = [sub(1), sub(2)];
  const { pub, calls } = node({ counts: { [busy.key]: 3 } });
  const seeded: [Hex, number][] = [];
  await rebuildDayCounts(
    pub,
    index(busy, quiet),
    { seedDayCount: (k, n) => seeded.push([k, n]) },
    100_000n,
    [TRUSTED],
  );
  assert.deepEqual(seeded, [[busy.key, 3]]);
  const q: string = calls[0]!.params[0].query;
  assert.match(q, new RegExp(`\\$creator = addr\\(${TRUSTED}\\)`)); // forged receipts can't eat the cap
  assert.match(q, /trigger_block >= u64\(\d+\)/);
});

test("mergeResync doesn't resurrect a subscription deleted live while discovery ran", () => {
  const old = index(sub(10), sub(20));
  const fresh = index(sub(10), sub(20)); // discovery read 20 just before its deletion
  old.remove(sub(20).key); // the live EntityDeleted
  const r = mergeResync(old, fresh, 40n);
  assert.equal(r.subs.get(sub(20).key), undefined);
  assert.equal(r.subs.removed.size, 0); // the new index starts with a clean slate
});

test("seedTargets drops expiring/changed/keep subs whose target isn't live; expired subs stay", async () => {
  const [warn, gone] = [
    sub(1, { trigger: "expiring", leadBlocks: 30n }),
    sub(2),
  ];
  const k = warn.targetKey!;
  const s = index(warn, { ...gone, targetKey: k });
  const { pub } = node({ logs: { [k]: [created(k, 700n)] } }); // expired while we were away
  await seedTargets(pub, s, new Targets(), 1_000n);
  assert.equal(s.get(warn.key), undefined); // can never warn about a dead target
  assert.ok(s.get(gone.key)); // `expired` is exactly for this
});
