import { test } from "node:test";
import assert from "node:assert/strict";
import { EntityMutationError } from "@arkiv-network/sdk";
import {
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  InternalRpcError,
} from "viem";
import { engineRevert } from "./errors.ts";

const wrap = (cause: Error) =>
  new EntityMutationError("Transaction failed", { cause });

test("a decoded engine error is a revert, named", () => {
  const e = wrap(
    Object.assign(
      new ContractFunctionRevertedError({ abi: [], functionName: "execute" }),
      { data: { errorName: "EntityExpired", args: [] } },
    ),
  );
  assert.deepEqual(engineRevert(e), {
    errorName: "EntityExpired",
    reason: "Transaction failed",
  });
});

test("viem's revert classes without a decoded engine error are infrastructure, not reverts", () => {
  // getContractError maps JSON-RPC -32603 to this class; getNodeError maps "gas required exceeds allowance" to the other.
  const internal = new ContractFunctionRevertedError({
    abi: [],
    functionName: "execute",
    message: "upstream timeout",
  });
  assert.equal(engineRevert(wrap(internal)), undefined);
  assert.equal(
    engineRevert(
      wrap(
        new ExecutionRevertedError({
          message: "gas required exceeds allowance",
        }),
      ),
    ),
    undefined,
  );
  assert.equal(
    engineRevert(wrap(new InternalRpcError(new Error("boom")))),
    undefined,
  );
  assert.equal(engineRevert(new Error("fetch failed")), undefined);
});
