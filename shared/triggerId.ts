// Deterministic receipt id (LLD §4): every worker derives the same id for the same trigger,
// so "did anyone already act?" is one free count on trigger_id. Browser-safe.
import { encodePacked, keccak256, type Hex } from "viem";
import type { Event } from "./schema.ts";

// No block hash in the id: Tiramisu has a single block producer, so reorgs aren't expected.
// Known limit: a reorged trigger could be suppressed by a stale receipt.
// Named fields, not positional args: subscription and subject are both Hex and easy to swap.
// A keep trigger is named "keep", not by its outcome (kept, keep_skipped, …), so every outcome of one
// trigger shares an id and A and B dedupe across them.
// encodePacked is unambiguous here: `event` is the only variable-length field.
export const triggerId = (t: {
  subscription: Hex;
  subject: Hex;
  event: Event | "keep";
  triggerBlock: bigint;
}): Hex =>
  keccak256(
    encodePacked(
      ["bytes32", "bytes32", "string", "uint64"],
      [t.subscription, t.subject, t.event, t.triggerBlock],
    ),
  );
