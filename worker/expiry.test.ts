import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex, type Hex } from "viem";
import type { Sub } from "../shared/subscription.ts";
import { dueTriggers, ExpiryMonitor, Targets } from "./expiry.ts";
import { SubsIndex } from "./subs.ts";

const hex = (n: number, len = 64) =>
  `0x${n.toString(16).padStart(len, "0")}` as Hex;
const TARGET = hex(1000);
const OWNER = hex(7, 40);
const sub = (n: number, o: Partial<Sub> = {}): Sub => ({
  key: hex(n),
  creator: hex(1, 40),
  createdAt: BigInt(n),
  expiresAt: 900_000n,
  publicMonitor: false,
  trigger: "expiring",
  label: `sub ${n}`,
  maxPerDay: 20,
  targetKey: TARGET,
  leadBlocks: 30n,
  ...o,
});

// One watched target expiring at block 1,000, with an `expiring` (lead 30) and an `expired` sub.
function setup() {
  const subs = new SubsIndex();
  subs.add(sub(1));
  subs.add(sub(2, { trigger: "expired", leadBlocks: undefined }));
  const targets = new Targets();
  targets.set(TARGET, {
    expiresAt: 1_000n,
    creator: OWNER,
    owner: OWNER,
    flags: { readonly: false, permissionlessExtension: false },
  });
  return { subs, targets };
}
const events = (r: ReturnType<typeof dueTriggers>) =>
  r.fires.map((f) => `${f.event}@${f.triggerBlock}`);

test("warned fires at exactly exp − lead, not a block before", () => {
  const { subs, targets } = setup();
  assert.deepEqual(events(dueTriggers(969n, targets, subs)), []);
  const r = dueTriggers(970n, targets, subs);
  assert.deepEqual(events(r), ["warned@970"]);
  assert.deepEqual(r.fires[0]!.seen, { creator: OWNER, owner: OWNER });
});

test("expired fires only after a confirmed null, at the expiry block", () => {
  const { subs, targets } = setup();
  const r = dueTriggers(1_000n, targets, subs);
  assert.deepEqual(events(r), ["warned@970"]); // not expired yet: unconfirmed
  assert.deepEqual(r.confirm, [TARGET]);
  targets.markGone(TARGET);
  const after = dueTriggers(1_001n, targets, subs);
  assert.deepEqual(events(after), ["expired@1000"]); // and no more warnings
  assert.deepEqual(after.confirm, []); // no further reads
});

test("a re-extended target re-arms with a new trigger block", () => {
  const { subs, targets } = setup();
  assert.deepEqual(events(dueTriggers(970n, targets, subs)), ["warned@970"]);
  targets.extend(TARGET, 2_000n);
  assert.deepEqual(events(dueTriggers(1_500n, targets, subs)), []);
  assert.deepEqual(events(dueTriggers(1_970n, targets, subs)), ["warned@1970"]);
});

// A fake node for rawGetEntity: `alive` = the expiresAt it reports, or null for a gone entity.
function monitor(alive: bigint | null) {
  const { subs, targets } = setup();
  const f = { reads: 0, release: () => {}, fired: [] as string[] };
  const gate = new Promise<void>((r) => (f.release = r));
  const pub = {
    request: async () => {
      f.reads++;
      await gate;
      return alive === null
        ? null
        : {
            key: TARGET,
            creator: OWNER,
            owner: OWNER,
            createdAt: toHex(1),
            expiresAt: toHex(alive),
            attributes: [],
          };
    },
  };
  const receipts = {
    fire: async (_s: Sub, _t: Hex, event: string, block: bigint) => {
      f.fired.push(`${event}@${block}`);
    },
  };
  const m = new ExpiryMonitor({
    pub: pub as never,
    targets,
    subs: () => subs,
    receipts,
  });
  return { f, m, subs, targets };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test("alive at the expiry block → expiresAt resynced and nothing expires", async () => {
  const { f, m, targets } = monitor(1_500n);
  m.onHead(1_000n);
  m.onHead(1_001n); // read still pending: not asked twice
  assert.equal(f.reads, 1);
  f.release();
  await settle();
  assert.equal(targets.get(TARGET)!.expiresAt, 1_500n);
  assert.equal(targets.get(TARGET)!.gone, false);
  m.onHead(1_002n);
  assert.equal(f.reads, 1); // resynced: no read every block
  assert.ok(!f.fired.some((e) => e.startsWith("expired")));
});

test("null at the expiry block → expired goes to fire() on the next head", async () => {
  const { f, m } = monitor(null);
  m.onHead(1_000n);
  f.release();
  await settle();
  m.onHead(1_001n);
  assert.ok(f.fired.includes("expired@1000"));
  m.onHead(1_002n); // offered again until it succeeds; fire() makes repeats free
  assert.equal(f.fired.filter((e) => e === "expired@1000").length, 2);
  assert.equal(f.reads, 1);
});

test("a target nobody watches any more is dropped from the cache", () => {
  const { m, subs, targets } = monitor(null);
  subs.remove(hex(1));
  subs.remove(hex(2));
  m.onHead(10n);
  assert.equal(targets.size, 0);
});
