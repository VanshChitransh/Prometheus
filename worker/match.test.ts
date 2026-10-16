import { test } from "node:test";
import assert from "node:assert/strict";
import type { EntityCreatedEvent } from "@arkiv-network/sdk";
import { checksumAddress, type Hex } from "viem";
import { parseSearch } from "../shared/searchAst.ts";
import type { Sub } from "../shared/subscription.ts";
import { matchCreated } from "./match.ts";

const hex = (n: number, len = 64) =>
  `0x${n.toString(16).padStart(len, "0")}` as Hex;
const ENTITY = hex(1000);
const OWNER = "0x6a693fd642c1f8f5e78321c2722208a3791ee79b" as Hex; // lowercase, as events report it
const WORKER = hex(9, 40);
const search = parseSearch({ eq: ["kind", { str: "blood_request" }] });
const sub = (n: number, o: Partial<Sub> = {}): Sub => ({
  key: hex(n),
  creator: hex(1, 40),
  createdAt: BigInt(n),
  expiresAt: 900_000n,
  publicMonitor: false,
  trigger: "new_match",
  label: `sub ${n}`,
  maxPerDay: 20,
  search,
  ...o,
});
const event = (owner = OWNER) =>
  ({
    type: "EntityCreated",
    entityKey: ENTITY,
    owner,
    blockNumber: 500n,
  }) as unknown as EntityCreatedEvent;

// count(query) scripts the node's answer; returns what was queried, fired, and the most counts at once.
async function run(subs: Sub[], count = (_q: string) => 1, owner = OWNER) {
  const queries: string[] = [];
  const fired: string[] = [];
  let active = 0;
  let peak = 0;
  const later = await matchCreated({
    e: event(owner),
    subs,
    pub: {
      request: async ({ params }: { params: [{ query: string }] }) => {
        queries.push(params[0].query);
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return count(params[0].query);
      },
    } as never,
    receipts: {
      fire: async (s, subject, ev, block, seen) => {
        assert.equal(subject, ENTITY);
        assert.deepEqual(seen, { creator: owner, owner });
        fired.push(`${s.label}:${ev}@${block}`);
        return "done" as const;
      },
    },
    workers: [WORKER],
  });
  assert.deepEqual(fired, []); // the counts never fire: that's the Later's job, outside the limiter
  await later?.();
  return { queries, fired, peak };
}

test("fires matched at the log's block when the count is 1", async () => {
  const r = await run([sub(1)]);
  assert.deepEqual(r.fired, ["sub 1:matched@500"]);
  assert.match(r.queries[0]!, /kind = str\('blood_request'\)/);
  assert.match(r.queries[0]!, /\$key = /);
});

test("no fire when the entity doesn't match", async () => {
  const r = await run([sub(1)], () => 0);
  assert.deepEqual(r.fired, []);
});

test("owner prefilter: skipped without a count; a checksummed target_owner still matches", async () => {
  const r = await run([
    sub(1, { targetOwner: hex(5, 40) }),
    sub(2, { targetOwner: checksumAddress(OWNER) }),
  ]);
  assert.equal(r.queries.length, 1);
  assert.deepEqual(r.fired, ["sub 2:matched@500"]);
});

test("ignores other triggers and our own workers' entities", async () => {
  const other = await run([sub(1, { trigger: "expiring", search: undefined })]);
  assert.deepEqual(other.queries, []);
  const own = await run([sub(1)], () => 1, WORKER);
  assert.deepEqual(own.queries, []);
});

test("counts run one at a time, so the dispatch limiter's cap holds for the node", async () => {
  const r = await run([sub(1), sub(2), sub(3)]);
  assert.equal(r.peak, 1);
  assert.equal(r.fired.length, 3);
});

test("an expired subscription isn't evaluated", async () => {
  const r = await run([sub(1, { expiresAt: 400n })]); // expired before block 500
  assert.deepEqual(r.queries, []);
});
