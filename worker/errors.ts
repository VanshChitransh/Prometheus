// The one place that decides "the chain refused this write" vs "the write didn't get through".
import { ContractFunctionRevertedError } from "viem";

export type EngineRevert = { errorName: string; reason: string };

// Only a revert decoded to a named engine error (EntityExpired, ExpiryNotExtended, …) is a verdict on
// the write. viem also maps JSON-RPC -32603 and "gas required exceeds allowance" to its revert classes
// (getContractError, getNodeError); those are infrastructure trouble and must be retried, not dropped.
// Same test as the SDK's own describeEntityRevert. The SDK wraps every failure in EntityMutationError,
// so walk the cause chain.
export function engineRevert(e: unknown): EngineRevert | undefined {
  for (let x = e; x instanceof Error; x = x.cause)
    if (x instanceof ContractFunctionRevertedError && x.data?.errorName)
      return { errorName: x.data.errorName, reason: (e as Error).message };
  return undefined;
}
