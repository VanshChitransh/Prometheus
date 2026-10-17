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
    project?: string;
    fixedExp?: boolean; // the chain's expiry doesn't move (to hit the budget, not rule 4)
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
              ...(o.project
                ? [{ name: "project", type: "str", value: o.project }]
                : []),
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
      if (!o.fixedExp) f.exp = p.extensions[0].expires.expiresAt;
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

test("A and B racing on one chain extend to the same block, not twice", async () => {
  // One shared chain. Both workers read exp 1,000 before either tx lands; the node keeps the later
  // of the current and requested expiry, so an equal request is a no-op.
  const chain = { exp: 1_000n };
  const make = () =>
    new Keeper({
      writer: {
        batch: async (p: any) => {
          await new Promise((r) => setTimeout(r, 2));
          const want = p.extensions[0].expires.expiresAt as bigint;
          if (want > chain.exp) chain.exp = want;
          return { ok: true, value: {} };
        },
      } as never,
      pub: {
        request: async () => ({
          key: TARGET,
          creator: OWNER,
          owner: OWNER,
          createdAt: toHex(1),
          expiresAt: toHex(chain.exp),
          creationFlags: { readonly: false, permissionlessExtension: true },
          attributes: [],
        }),
        getBalance: async () => parseEther("1"),
      } as never,
      targets: new Targets(),
      address: hex(5, 40),
    });
  const args = {
    sub: SUB,
    target: TARGET,
    id: ID,
    triggerBlock: HEAD,
    head: HEAD,
  };
  await Promise.all([make().keep(args), make().keep(args)]);
  assert.equal(chain.exp, 1_150n); // exp + keep_blocks once, never exp + 2 x keep_blocks
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

test("the daily keep budget caps how many extends one worker pays for", async () => {
  const { f, keep } = setup({ fixedExp: true });
  for (let i = 0; i < 200; i++) assert.equal(await keep(), undefined);
  assert.equal((await keep())?.note, "budget");
  assert.equal(f.batches.length, 200);
});

test("never extends Prometheus's own entities (subscriptions keeping each other alive)", async () => {
  const { f, keep } = setup({ project: "prometheus", kind: "subscription" });
  assert.equal((await keep())?.note, "deny_listed");
  assert.equal(f.batches.length, 0);
});

// A spent budget is this worker's condition, not the trigger's: under the keep's own id it made
// the other worker think the keep was done, so the target lapsed although B had budget.
test("a spent budget writes keep_skipped(budget) once, under its own id, and keeps offering", async () => {
  const { keep } = setup({ fixedExp: true });
  for (let i = 0; i < 200; i++) await keep();
  const first = await keep();
  assert.equal(first?.event, "keep_skipped");
  assert.equal(first?.note, "budget");
  assert.equal(first?.retry, true); // not done: B (with budget) can still act, and so can A tomorrow
  assert.notEqual(first?.id, ID);
  assert.deepEqual(await keep(), { retry: true }); // no second receipt
});

test("a send that throws (network) gives its budget unit back", async () => {
  const { keep } = setup({ batch: "throw", fixedExp: true });
  for (let i = 0; i < 200; i++) await assert.rejects(keep(), /network/);
  await assert.rejects(keep(), /network/); // still attempted: no budget burnt by retries
});

test("already_expired keeps the target's creator and owner from the cache", async () => {
  const out = await setup({ gone: true }).keep();
  assert.equal(out?.note, "already_expired");
  assert.deepEqual(out?.seen, { creator: OWNER, owner: OWNER });
});
