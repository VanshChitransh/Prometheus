import { test } from "node:test";
import assert from "node:assert/strict";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { parseEther, toHex, type Hex } from "viem";
import type { Sub } from "../shared/subscription.ts";
import { Targets } from "./expiry.ts";
import { Keeper } from "./keeper.ts";

const hex = (n: number, len = 64) =>
  `0x${n.toString(16).padStart(len, "0")}` as Hex;
const TARGET = hex(1000);
const OWNER = hex(7, 40);
const ID = hex(42);
const SUB: Sub = {
  key: hex(1),
  creator: hex(1, 40),
  createdAt: 1n,
  expiresAt: 900_000n,
  publicMonitor: false,
  trigger: "keep",
  label: "keep it",
  maxPerDay: 20,
  targetKey: TARGET,
  leadBlocks: 30n,
  keepBlocks: 150n,
};
const HEAD = 970n; // the trigger block: exp (1,000) − lead (30)

// A fake chain around one target. `batch` decides the writer's answer.
function setup(
  o: {
    permissionless?: boolean;
    kind?: string;
    expiresAt?: bigint;
    gone?: boolean;
    balance?: string;
    notExtended?: boolean;
    batch?: "ok" | "expired" | "refused" | "throw";
    cached?: boolean;
  } = {},
) {
  // `exp` is the chain's view of the target; a landed keep moves it, like the node would.
  const f = {
    reads: 0,
    batches: [] as any[],
    exp: o.expiresAt ?? 1_000n,
    balance: o.balance ?? "1",
  };
  const flags = {
    readonly: false,
    permissionlessExtension: o.permissionless ?? true,
  };
  const pub = {
    request: async () => {
      f.reads++;
      return o.gone
        ? null
        : {
            key: TARGET,
            creator: OWNER,
            owner: OWNER,
            createdAt: toHex(1),
            expiresAt: toHex(f.exp),
            creationFlags: flags,
            attributes: [
              { name: "kind", type: "str", value: o.kind ?? "listing" },
            ],
          };
    },
    getBalance: async () => parseEther(f.balance),
  };
  const writer = {
    batch: async (p: any) => {
      f.batches.push(p);
      // Refusals carry the engine's error name, as the Writer reports it.
      const refuse = (errorName: string, reason: string) => ({
        ok: false,
        errorName,
        reason,
      });
      if (o.notExtended)
        return refuse(
          "ExpiryNotExtended",
          "entity 0x… already expires at block 1200, so extending it to 1150 would shorten its life",
        );
      if (o.batch === "throw") throw new Error("network");
      if (o.batch === "expired")
        return refuse(
          "EntityNotFound",
          "no entity 0x… — it may have been deleted, or have expired",
        );
      if (o.batch === "refused")
        return refuse("InvalidOpType", "Transaction failed: something else");
      f.exp = p.extensions[0].expires.expiresAt;
      return { ok: true, value: {} };
    },
  };
  const targets = new Targets();
  if (o.cached !== false)
    targets.set(TARGET, {
      expiresAt: 1_000n,
      creator: OWNER,
      owner: OWNER,
      flags,
    });
  const keeper = new Keeper({
    writer: writer as never,
    pub: pub as never,
    targets,
    address: hex(5, 40),
  });
  const keep = (sub: Sub = SUB) =>
    keeper.keep({
      sub,
      target: TARGET,
      id: ID,
      triggerBlock: HEAD,
      head: HEAD,
    });
  return { f, keep };
}

test("refuses a target created without permissionlessExtension, without a read", async () => {
  const { f, keep } = setup({ permissionless: false });
  assert.deepEqual(await keep(), {
    event: "keep_skipped",
    note: "not_permissionless",
    seen: { creator: OWNER, owner: OWNER },
  });
  assert.equal(f.reads, 0); // flags never change: the cache is enough
  assert.equal(f.batches.length, 0);
});

test("refuses deny-listed targets (canaries are meant to lapse)", async () => {
  const { f, keep } = setup({ kind: "liveness-Canary" });
  assert.equal((await keep())?.note, "deny_listed");
  assert.equal(f.batches.length, 0);
});

test("already_extended when someone pushed the expiry past this window", async () => {
  const { f, keep } = setup({ expiresAt: 1_200n }); // > head + lead
  assert.equal((await keep())?.note, "already_extended");
  assert.equal(f.batches.length, 0);
});

test("pauses below the 0.005 GLM reserve: keeper_low_funds, no transaction", async () => {
  const { f, keep } = setup({ balance: "0.0049" });
  assert.equal((await keep())?.event, "keeper_low_funds");
  assert.equal(f.batches.length, 0);
});

test("keeps: one atomic batch with the extension and its kept receipt", async () => {
  const { f, keep } = setup();
  assert.equal(await keep(), undefined); // the receipt rode in the same transaction
  const [b] = f.batches;
  assert.equal(f.batches.length, 1);
  assert.deepEqual(b.extensions, [
    { entityKey: TARGET, expires: ExpirationTime.atBlock(1_000n + 150n) },
  ]);
  assert.equal(b.creates.length, 1);
  assert.equal(b.creates[0].attributes.event, "kept");
  assert.equal(b.creates[0].flags.readonly, true);
});

test("A and B compute the same atBlock, so a race can't extend twice", async () => {
  const a = setup();
  const b = setup();
  await a.keep();
  await b.keep();
  assert.deepEqual(a.f.batches[0].extensions, b.f.batches[0].extensions);
});

test("refused batches: lapsed target → already_expired; anything else → keep_failed", async () => {
  assert.equal(
    (await setup({ batch: "expired" }).keep())?.note,
    "already_expired",
  );
  const failed = await setup({ batch: "refused" }).keep();
  assert.equal(failed?.event, "keep_failed");
  assert.match(failed?.note ?? "", /something else/);
});

test("gone before we acted → already_expired; a network error throws so fire() retries", async () => {
  assert.equal(
    (await setup({ gone: true, cached: false }).keep())?.note,
    "already_expired",
  );
  await assert.rejects(setup({ batch: "throw" }).keep(), /network/);
});

test("two keep subs on one target: one extension; the second sees it and skips", async () => {
  const { f, keep } = setup();
  const [a, b] = await Promise.all([
    keep(),
    keep({ ...SUB, key: hex(2), keepBlocks: 100n }),
  ]);
  assert.equal(a, undefined);
  assert.equal(b?.note, "already_extended"); // re-read after the first landed: no stale tx
  assert.equal(f.batches.length, 1);
});

test("ExpiryNotExtended (someone extended further meanwhile) → already_extended, not keep_failed", async () => {
  assert.equal(
    (await setup({ notExtended: true }).keep())?.note,
    "already_extended",
  );
});

test("low funds: one receipt under its own id, then quiet retries, then a refill keeps", async () => {
  const { f, keep } = setup({ balance: "0.001" });
  const first = await keep();
  assert.equal(first?.event, "keeper_low_funds");
  assert.equal(first?.retry, true); // not done: the trigger is offered again
  assert.notEqual(first?.id, ID); // its own id, so the dedupe doesn't count it as the keep
  assert.deepEqual(await keep(), { retry: true }); // still low: no second receipt
  f.balance = "1";
  assert.equal(await keep(), undefined); // refilled: kept
  assert.equal(f.batches.length, 1);
});

test("the deny-list catches common spellings", async () => {
  for (const kind of [
    "dead-man-switch",
    "keep_alive",
    "heart-beat",
    "Watchdog",
  ])
    assert.equal((await setup({ kind }).keep())?.note, "deny_listed", kind);
});
