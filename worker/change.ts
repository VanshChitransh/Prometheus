// The `changed` trigger (LLD §3.3): a watched target was patched, transferred or deleted. No RPC:
// the event says what happened, the target cache says whose it was. Node only.
import type { Hex } from "viem";
import type { Sub } from "../shared/subscription.ts";
import type { Later } from "./match.ts";
import { throwIfFailed, type Receipts, type Seen } from "./receipts.ts";

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
  // A subscription that expired by this block no longer asks (it lingers until the hourly re-sync);
  // one created at or after it didn't ask yet: a replay would alert on its past (a live worker
  // can't have served it then).
  const watching = o.subs.filter(
    (s) =>
      s.trigger === "changed" && s.createdAt < o.block && s.expiresAt > o.block,
  );
  if (watching.length === 0) return;
  // A change is never offered again, so a failed fire throws and the dispatcher retries the Later.
  return () =>
    Promise.all(
      watching.map((sub) =>
        o.receipts.fire(sub, o.subject, o.event, o.block, o.seen),
      ),
    ).then(throwIfFailed);
}
