import { test } from "node:test";
import assert from "node:assert/strict";
import { EntityMutationError } from "@arkiv-network/sdk";
import { ContractFunctionRevertedError, toHex } from "viem";
import { Writer } from "./writer.ts";

// A fake wallet: `chainNonce` is what the node reports as pending; `failNext` makes upcoming sends throw.
function fake() {
  const f = {
    chainNonce: 5,
    reads: 0,
    sent: [] as number[],
    inFlight: 0,
    maxInFlight: 0,
    failNext: [] as unknown[],
  };
  const send = async (_p: unknown, tx: { nonce: number }) => {
    f.inFlight++;
    f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
    f.sent.push(tx.nonce);
    await new Promise((r) => setTimeout(r, 1));
    f.inFlight--;
    const err = f.failNext.shift();
    if (err) throw err;
    return { nonce: tx.nonce };
  };
  const wallet = {
    account: { address: `0x${"1".repeat(40)}` },
    request: async ({ method }: { method: string }) => {
      assert.equal(method, "eth_getTransactionCount");
      f.reads++;
      return toHex(f.chainNonce);
    },
    createEntity: send,
    extendEntity: send,
    executeBatch: send,
  };
  return { f, writer: new Writer(wallet as never) };
}

const revert = () =>
  new EntityMutationError("Transaction failed: entity expired", {
    cause: new ContractFunctionRevertedError({
      abi: [],
      functionName: "execute",
    }),
  });

test("concurrent writes go out one at a time with nonces n, n+1, n+2", async () => {
  const { f, writer } = fake();
  const results = await Promise.all([
    writer.create({} as never),
    writer.extend({} as never),
    writer.batch({} as never),
  ]);
  assert.deepEqual(f.sent, [5, 6, 7]);
  assert.equal(f.maxInFlight, 1);
  assert.equal(f.reads, 1); // read once, then counted locally
  assert.ok(results.every((r) => r.ok));
});

test("after a network failure the next send re-reads the nonce", async () => {
  const { f, writer } = fake();
  await writer.create({} as never); // 5, counter → 6
  f.failNext.push(new Error("fetch failed"));
  await assert.rejects(writer.create({} as never), /fetch failed/);
  f.chainNonce = 6; // the failed tx never left
  await writer.create({} as never);
  assert.deepEqual(f.sent, [5, 6, 6]);
  assert.equal(f.reads, 2);
});

test("a revert returns a reason, isn't retried, and doesn't block the queue", async () => {
  const { f, writer } = fake();
  f.failNext.push(revert());
  const [bad, good] = await Promise.all([
    writer.extend({} as never),
    writer.create({} as never),
  ]);
  assert.deepEqual(bad, {
    ok: false,
    reason: "Transaction failed: entity expired",
  });
  assert.ok(good.ok);
  assert.deepEqual(f.sent, [5, 5]); // one attempt each; the second re-read the nonce
  assert.equal(f.reads, 2);
});
