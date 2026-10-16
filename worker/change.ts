// The `changed` trigger (LLD §3.3): a watched target was patched, transferred or deleted. No RPC:
// the event says what happened, the target cache says whose it was. Node only.
import type { Hex } from "viem";
import type { Sub } from "../shared/subscription.ts";
import type { Later } from "./match.ts";
import type { Receipts, Seen } from "./receipts.ts";

// Returns the fires as a Later, like matchCreated: worker B's delay_blocks wait mustn't hold a
// dispatch slot, and the block settles only after them, since a change event is never offered again.
// Several changes of one kind in one block share a trigger id, so they make one receipt.
export function fireChanged(o: {
  subs: Sub[]; // the subscriptions watching `subject`
  subject: Hex;
  event: "patched" | "owner_changed" | "deleted";
  block: bigint;
  seen?: Seen;
  receipts: Pick<Receipts, "fire">;
}): Later | undefined {
  const watching = o.subs.filter((s) => s.trigger === "changed");
  if (watching.length === 0) return;
  return () =>
    Promise.all(
      watching.map((sub) =>
        o.receipts.fire(sub, o.subject, o.event, o.block, o.seen),
      ),
    );
}
