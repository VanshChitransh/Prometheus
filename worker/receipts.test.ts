import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { Sub } from "../shared/subscription.ts";
import { triggerId } from "../shared/triggerId.ts";
import { Receipts } from "./receipts.ts";

const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const TARGET = hex(1000);
const SUB: Sub = {
  key: hex(1),
  creator: `0x${"1".repeat(40)}`,
  createdAt: 1n,
  expiresAt: 900_000n,
  publicMonitor: false,
  trigger: "expiring",
  label: "test",
  maxPerDay: 20,
  targetKey: TARGET,
  leadBlocks: 30n,
};
const idFor = (triggerBlock: bigint) =>
  triggerId({
    subscription: SUB.key,
    subject: TARGET,
    event: "warned",
    triggerBlock,
  });

// Polls (up to 2 s) until `cond` holds: fire(), flushes and the real file writes settle over many turns.
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const TRUSTED = `0x${"5".repeat(40)}` as Hex;

// A fake chain: `landed` holds trigger ids with a receipt from a trusted worker; `forged` holds ids
// with a receipt from some other wallet, which only a query without the $creator filter would count. The writer records batches;
// `next` makes the next batch throw ("throw") or be refused ("refuse").
async function fake(
  delayBlocks = 0,
  keeper?: ConstructorParameters<typeof Receipts>[0]["keeper"],
) {
  const file = join(await mkdtemp(join(tmpdir(), "receipts-")), "pending.json");
  const f = {
    file,
    landed: new Set<Hex>(),
    forged: new Set<Hex>(),
    counts: 0,
    failCount: false,
    batches: [] as Hex[][],
    fileDuringSend: "",
    next: undefined as "throw" | "refuse" | "landThenThrow" | undefined,
    refuseId: undefined as Hex | undefined, // refuse any batch holding this receipt
  };
  const pub = {
    request: async ({ params }: { params: [{ query: string }] }) => {
      f.counts++;
      if (f.failCount) {
        f.failCount = false;
        throw new Error("rpc down");
      }
      const q = params[0].query;
      const id = q.match(/bytes32\((0x[0-9a-f]+)\)/)![1] as Hex;
      const trusted =
        f.landed.has(id) && q.includes(`$creator = addr(${TRUSTED})`);
      const forged = f.forged.has(id) && !q.includes("$creator");
      return trusted || forged ? 1 : 0;
    },
  };
  const writer = {
    batch: async (p: {
      creates: { attributes: Record<string, unknown> }[];
    }) => {
      f.fileDuringSend = await readFile(file, "utf8");
      const outcome = f.next;
      f.next = undefined;
      const ids = p.creates.map(
        (c) =>
          JSON.stringify(c.attributes.trigger_id).match(
            /0x[0-9a-f]{64}/,
          )![0] as Hex,
      );
      if (outcome === "throw") throw new Error("network");
      if (outcome === "landThenThrow") {
        for (const id of ids) f.landed.add(id); // it went out; only the receipt wait failed
        throw new Error("receipt wait timed out");
      }
      if (outcome === "refuse" || (f.refuseId && ids.includes(f.refuseId)))
        return {
          ok: false,
          errorName: "InvalidValueType",
          reason: "bad receipt",
        };
      // The SDK's bytes32() value: { value: 0x… } (any shape works; we only count batches).
      f.batches.push(
        p.creates.map((c) => JSON.stringify(c.attributes.trigger_id) as Hex),
      );
      return { ok: true, value: {} };
    },
  };
  const r = new Receipts({
    writer: writer as never,
    pub: pub as never,
    delayBlocks,
    file,
    trustedWorkers: [TRUSTED],
    keeper,
  });
  return { f, r };
}

test("20 fire() calls for one trigger while B waits → exactly 1 receipt queued", async () => {
  const { f, r } = await fake(15);
  r.onHead(100n);
  for (let i = 0; i < 20; i++) void r.fire(SUB, TARGET, "warned", 100n);
  r.onHead(114n);
  await new Promise((res) => setTimeout(res, 20)); // a real wait: every fire has had its turns
  assert.equal(r.queued, 0); // B still waiting
  assert.equal(f.counts, 0);
  r.onHead(115n);
  await until(() => r.queued === 1, "one receipt");
  assert.equal(f.counts, 1); // one "already done?" check, not 20
});

test("A queues at once; B skips at +15 when A's receipt is already on chain", async () => {
  const a = await fake(0);
  a.r.onHead(100n);
  await a.r.fire(SUB, TARGET, "warned", 100n);
  assert.equal(a.r.queued, 1);

  const b = await fake(15);
  b.f.landed.add(idFor(100n));
  b.r.onHead(100n);
  const done = b.r.fire(SUB, TARGET, "warned", 100n);
  b.r.onHead(115n);
  await done;
  assert.equal(b.r.queued, 0);
  await b.r.fire(SUB, TARGET, "warned", 100n); // remembered as done: no second check
  assert.equal(b.f.counts, 1);
});

test("the daily cap blocks a subscription's 21st receipt", async () => {
  const { r } = await fake();
  r.onHead(1_000n);
  for (let b = 1n; b <= 21n; b++) await r.fire(SUB, TARGET, "warned", b);
  assert.equal(r.queued, 20);
});

test("a free count that throws once → the trigger fires on the next head", async () => {
  const { f, r } = await fake();
  f.failCount = true;
  r.onHead(100n);
  await r.fire(SUB, TARGET, "warned", 100n);
  assert.equal(r.queued, 0); // not marked fired, claim released
  r.onHead(101n);
  await r.fire(SUB, TARGET, "warned", 100n); // the monitor calls again on the next head
  assert.equal(r.queued, 1);
});

test("10 receipts flush in one batch; the file holds them during the send, then empties", async () => {
  const { f, r } = await fake();
  r.onHead(1_000n);
  for (let b = 1n; b <= 10n; b++) await r.fire(SUB, TARGET, "warned", b);
  r.onHead(1_001n);
  await until(() => f.batches.length === 1, "the flush");
  assert.equal(f.batches[0]!.length, 10);
  assert.equal(JSON.parse(f.fileDuringSend).length, 10);
  let onDisk = "";
  await until(() => {
    void readFile(f.file, "utf8").then((t) => (onDisk = t));
    return onDisk === "[]";
  }, "the file to empty after the send");
});

test("a batch that throws is requeued and retried after the backoff", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { f, r } = await fake();
    r.onHead(1_000n);
    for (let b = 1n; b <= 10n; b++) await r.fire(SUB, TARGET, "warned", b);
    f.next = "throw";
    r.onHead(1_001n);
    await until(
      () => r.queued === 10 && f.fileDuringSend !== "",
      "the requeue",
    );
    await new Promise((res) => setTimeout(res, 20));
    r.onHead(1_002n); // inside the 10 s recheck delay: no attempt
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(f.batches.length, 0);
    mock.timers.tick(10_000); // the recheck waits ≥ 10 s after a thrown send
    r.onHead(1_003n);
    await until(() => f.batches.length === 1 && r.queued === 0, "the retry");
  } finally {
    mock.timers.reset();
  }
});

test("a refused batch is resent one at a time, so only the malformed receipt is dropped", async () => {
  const { f, r } = await fake();
  r.onHead(1_000n);
  for (let b = 1n; b <= 10n; b++) await r.fire(SUB, TARGET, "warned", b);
  f.refuseId = idFor(3n); // one bad receipt in the batch
  for (let h = 1_001n; f.batches.flat().length < 9 && h < 1_200n; h += 5n) {
    r.onHead(h);
    await new Promise((res) => setTimeout(res, 15));
  }
  assert.equal(f.batches.flat().length, 9); // the 9 good ones landed, one per transaction
  assert.equal(r.queued, 0);
});

test("a send that threw after it went out isn't written twice", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { f, r } = await fake();
    r.onHead(1_000n);
    for (let b = 1n; b <= 10n; b++) await r.fire(SUB, TARGET, "warned", b);
    f.next = "landThenThrow";
    r.onHead(1_001n);
    await until(() => r.queued === 10 && f.landed.size === 10, "the requeue");
    await new Promise((res) => setTimeout(res, 20));
    mock.timers.tick(10_000); // the recheck waits ≥ 10 s after a thrown send
    r.onHead(1_010n);
    await until(() => r.queued === 0, "the recheck");
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(f.batches.length, 0); // every one was already on chain: nothing resent
  } finally {
    mock.timers.reset();
  }
});

test("resume() requeues only the receipts that never landed", async () => {
  const { f, r } = await fake();
  const saved = [1n, 2n].map((b) => ({
    id: idFor(b),
    subscription: SUB.key,
    subject: TARGET,
    event: "warned",
    triggerBlock: String(b),
    doneBlock: String(b),
  }));
  await writeFile(f.file, JSON.stringify(saved));
  f.landed.add(idFor(1n)); // the crash happened after this one's batch landed
  await r.resume();
  assert.equal(r.queued, 1);
  await r.fire(SUB, TARGET, "warned", 2n); // already queued: not added twice
  assert.equal(r.queued, 1);
  r.onHead(5_000n);
  await until(() => f.batches.length === 1, "the flush");
  assert.equal(f.batches[0]!.length, 1);
});

test("a forged receipt from an untrusted wallet doesn't suppress the real one", async () => {
  const { f, r } = await fake();
  f.forged.add(idFor(100n)); // anyone can compute trigger_id and write a lookalike
  r.onHead(100n);
  await r.fire(SUB, TARGET, "warned", 100n);
  assert.equal(r.queued, 1);
});

test("a seeded day count (restored after a restart) still caps the subscription", async () => {
  const { r } = await fake();
  r.seedDayCount(SUB.key, 19);
  r.onHead(1_000n);
  await r.fire(SUB, TARGET, "warned", 1n);
  await r.fire(SUB, TARGET, "warned", 2n);
  assert.equal(r.queued, 1); // 19 + 1 = maxPerDay
});

test("a keep trigger goes to the keeper; a skip is queued with its note, kept is not re-queued", async () => {
  const calls: Hex[] = [];
  const skipped = await fake(0, {
    keep: async (k) => {
      calls.push(k.id);
      return {
        event: "keep_skipped",
        note: "deny_listed",
        seen: { creator: TRUSTED, owner: TRUSTED },
      };
    },
  });
  skipped.r.onHead(1_000n);
  await skipped.r.fire(SUB, TARGET, "keep", 970n);
  await skipped.r.fire(SUB, TARGET, "keep", 970n); // fired: the keeper isn't asked twice
  assert.equal(calls.length, 1);
  assert.equal(skipped.r.queued, 1);
  skipped.r.onHead(1_010n);
  await until(() => skipped.f.batches.length === 1, "the flush");

  const kept = await fake(0, { keep: async () => undefined }); // receipt already in the extend tx
  kept.r.onHead(1_000n);
  await kept.r.fire(SUB, TARGET, "keep", 970n);
  assert.equal(kept.r.queued, 0);
});

test("a keep trigger with no keeper configured fails loudly and stays unfired", async () => {
  const { r } = await fake();
  r.onHead(1_000n);
  assert.equal(await r.fire(SUB, TARGET, "keep", 970n), "failed");
  assert.equal(await r.fire(SUB, TARGET, "keep", 970n), "failed"); // tried again, not "done"
  assert.equal(r.queued, 0);
});

test("keeps don't use max_per_day slots (skipping one would let the target lapse)", async () => {
  let calls = 0;
  const { r } = await fake(0, { keep: async () => (calls++, undefined) });
  r.seedDayCount(SUB.key, 20); // the alert cap is full
  r.onHead(1_000n);
  await r.fire(SUB, TARGET, "keep", 970n);
  assert.equal(calls, 1);
  await r.fire(SUB, TARGET, "warned", 970n); // alerts are still capped
  assert.equal(r.queued, 0);
});

test("a keep outcome with retry writes its receipt but stays unfired", async () => {
  let calls = 0;
  const { r } = await fake(0, {
    keep: async () =>
      ++calls === 1
        ? { event: "keeper_low_funds", retry: true, id: hex(77) }
        : undefined,
  });
  r.onHead(1_000n);
  await r.fire(SUB, TARGET, "keep", 970n);
  assert.equal(r.queued, 1); // the low-funds notice
  r.onHead(1_010n); // a deferred keep waits 10 blocks (WK-5)
  await r.fire(SUB, TARGET, "keep", 970n); // offered again, now funded
  assert.equal(calls, 2);
});

// WK-5: past the budget or below the reserve, the keeper answers "retry", and every head used to
// re-offer every due keep at 3 RPCs each (the count, a read, a balance), forever.
test("a keep the keeper defers is offered again every 10 blocks, not every head (WK-5)", async () => {
  let calls = 0;
  const { f, r } = await fake(0, {
    keep: async () => (calls++, { retry: true }),
  });
  for (let h = 1_000n; h < 1_020n; h++) {
    r.onHead(h);
    await r.fire(SUB, TARGET, "keep", 970n);
  }
  assert.equal(calls, 2); // heads 1,000 and 1,010
  assert.equal(f.counts, 2); // and no "already done?" count in between
});

// WK-7: fire() runs outside the dispatch limiter, so a burst of triggers counted all at once.
test("the 'already done?' counts run at most 8 at a time (WK-7)", async () => {
  let active = 0;
  let peak = 0;
  const r = new Receipts({
    writer: {} as never,
    pub: {
      request: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((res) => setTimeout(res, 2));
        active--;
        return 1; // the other worker already wrote it
      },
    } as never,
    delayBlocks: 0,
    file: join(await mkdtemp(join(tmpdir(), "receipts-")), "pending.json"),
    trustedWorkers: [TRUSTED],
  });
  r.onHead(1_000n);
  const sub = { ...SUB, maxPerDay: 100 };
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      r.fire(sub, TARGET, "warned", BigInt(i + 1)),
    ),
  );
  assert.equal(peak, 8);
});

// WK-8: the keeper forgets on restart that it already said "low funds" for this trigger.
test("a low-funds notice already on chain isn't queued again after a restart (WK-8)", async () => {
  const { f, r } = await fake(0, {
    keep: async () => ({ event: "keeper_low_funds", retry: true, id: hex(77) }),
  });
  f.landed.add(hex(77)); // written before the restart
  r.onHead(1_000n);
  assert.equal(await r.fire(SUB, TARGET, "keep", 970n), "failed"); // still not kept
  assert.equal(r.queued, 0);
});

test("100 concurrent fires on a sub capped at 20 queue exactly 20 (H4)", async () => {
  const { r } = await fake();
  r.onHead(1_000n);
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      r.fire(SUB, TARGET, "matched", BigInt(i + 1)),
    ),
  );
  assert.equal(r.queued, 20);
});

test("fire() reports done only once the receipt is in the pending file", async () => {
  const { f, r } = await fake();
  r.onHead(1_000n);
  assert.equal(await r.fire(SUB, TARGET, "warned", 970n), "done");
  // no wait: the checkpoint may pass this block right now, so the receipt must already be on disk
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).length, 1);
});

test("a bad trigger (negative block) is skipped, never thrown at a fire-and-forget caller", async () => {
  const { r } = await fake();
  assert.equal(await r.fire(SUB, TARGET, "warned", -5n), "skipped");
});

test("close() flushes what's queued, for a graceful shutdown", async () => {
  const { f, r } = await fake();
  r.onHead(1_000n);
  for (let b = 1n; b <= 3n; b++) await r.fire(SUB, TARGET, "warned", b);
  assert.equal(f.batches.length, 0); // below the flush threshold, no head since
  await r.close();
  assert.equal(f.batches.length, 1);
});

const quiet = async (fn: () => Promise<void>) => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {}; // refusals and drops are logged; keep output clean
  try {
    await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

// M4: each worker used to give the slot back when it found the other's receipt, so A and B each
// counted only their own writes and a cap of 20 let up to 40 alerts through.
test("a trigger the other worker wrote still uses a day slot: the cap holds across A and B", async () => {
  const { f, r } = await fake();
  const sub = { ...SUB, maxPerDay: 2 };
  r.onHead(1_000n);
  f.landed.add(idFor(1n));
  f.landed.add(idFor(2n));
  assert.equal(await r.fire(sub, TARGET, "warned", 1n), "done");
  assert.equal(await r.fire(sub, TARGET, "warned", 2n), "done");
  assert.equal(await r.fire(sub, TARGET, "warned", 3n), "skipped");
  assert.equal(r.queued, 0);
});

test("receipts resumed from the pending file count toward today's cap", async () => {
  const { f, r } = await fake();
  const sub = { ...SUB, maxPerDay: 3 };
  const saved = [1n, 2n].map((b) => ({
    id: idFor(b),
    subscription: SUB.key,
    subject: TARGET,
    event: "warned",
    triggerBlock: String(b),
    doneBlock: String(b),
  }));
  await writeFile(f.file, JSON.stringify(saved));
  await r.resume(); // 2 unsent: not on chain, so the restart's chain count can't see them
  r.seedDayCount(SUB.key, 1); // what the chain count found
  r.onHead(1_000n);
  assert.equal(await r.fire(sub, TARGET, "warned", 3n), "skipped"); // 2 + 1 = 3 already
});

test("a refused batch is bisected one receipt per head, not one per 5 blocks", async () => {
  const { f, r } = await fake();
  r.onHead(1_000n);
  for (let b = 1n; b <= 3n; b++) await r.fire(SUB, TARGET, "warned", b);
  f.refuseId = idFor(2n);
  await quiet(async () => {
    for (let h = 1_001n; h <= 1_004n; h++) {
      r.onHead(h);
      await new Promise((res) => setTimeout(res, 15));
    }
  });
  assert.equal(f.batches.flat().length, 2); // 1 and 3 landed; 2 was the malformed one
  assert.equal(r.queued, 0);
});

test("after a thrown send, the recheck waits 10 s so a tx that went out is indexed first", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { f, r } = await fake();
    r.onHead(1_000n);
    for (let b = 1n; b <= 10n; b++) await r.fire(SUB, TARGET, "warned", b);
    f.next = "throw";
    await quiet(async () => {
      r.onHead(1_001n);
      await until(
        () => r.queued === 10 && f.fileDuringSend !== "",
        "the requeue",
      );
      await new Promise((res) => setTimeout(res, 20));
    });
    const counts = f.counts;
    mock.timers.tick(9_999);
    r.onHead(1_002n);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(f.counts, counts); // no recheck yet
    assert.equal(f.batches.length, 0);
    mock.timers.tick(1);
    r.onHead(1_003n);
    await until(
      () => f.batches.length === 1 && r.queued === 0,
      "the recheck and resend",
    );
  } finally {
    mock.timers.reset();
  }
});
