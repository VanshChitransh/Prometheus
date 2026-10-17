// The `new_match` trigger (LLD §3.3, §5): on every created entity, one free count of
// `(search) AND $key = …` per subscription. Create-only (the UI says "new records only"): a record
// patched into a match later isn't seen. Node only.
import type { EntityCreatedEvent, PublicArkivClient } from "@arkiv-network/sdk";
import type { Hex } from "viem";
import { freeCount } from "../shared/arkiv.ts";
import { MATCH_SUBS_PER_EVENT } from "../shared/schema.ts";
import { withKey } from "../shared/searchAst.ts";
import type { Sub } from "../shared/subscription.ts";
import { throwIfFailed, type Receipts } from "./receipts.ts";

// Work a handler leaves for after its dispatch slot is freed, but before its block settles.
export type Later = () => Promise<unknown>;

// Runs the counts (the node calls the dispatch limiter caps) and returns the fires as a Later: on
// worker B, fire() waits delay_blocks (~30 s), which mustn't hold a slot. The checkpoint still waits
// for them: unlike an expiry, a created event is never offered again.
// The counts run one at a time, not concurrently as LLD §3.3 says: the dispatch limiter caps
// handlers, so N parallel counts per handler would put 16 × N on the node, past the 16 measured safe.
// ponytail: at ~330 ms a count (49/s at 16 in flight) live creates (~1/s) keep up to ~45 new_match
// subscriptions; past that, index them by trigger and share one count per distinct search.
export async function matchCreated(o: {
  e: EntityCreatedEvent;
  subs: Sub[];
  pub: PublicArkivClient;
  receipts: Pick<Receipts, "fire">;
  workers: readonly Hex[];
}): Promise<Later | undefined> {
  const { e, pub, receipts } = o;
  const owner = e.owner.toLowerCase();
  // Our own receipts are entities too: a search that matches them would fire on its own output.
  if (o.workers.some((w) => w.toLowerCase() === owner)) return;
  const candidates = o.subs.filter(
    (s) =>
      s.trigger === "new_match" &&
      s.createdAt < e.blockNumber && // new records only: a replay mustn't match its past
      s.expiresAt > e.blockNumber && // an expired subscription no longer asks
      (!s.targetOwner || s.targetOwner.toLowerCase() === owner),
  );
  // At most MATCH_SUBS_PER_EVENT, oldest first (audit M5): the per-creator cap is 20, so three
  // throwaway wallets could otherwise fill the dispatch slots with match counts and stall every other
  // event. And one count per distinct search: subscriptions asking the same question share it.
  if (candidates.length > MATCH_SUBS_PER_EVENT) warnCapped(candidates.length);
  const bySearch = new Map<string, Sub[]>();
  for (const s of candidates
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    )
    .slice(0, MATCH_SUBS_PER_EVENT)) {
    const q = s.search!.toString();
    const group = bySearch.get(q);
    if (group) group.push(s);
    else bySearch.set(q, [s]);
  }
  const matched: Sub[] = [];
  for (const group of bySearch.values())
    if (
      (await freeCount(
        pub,
        withKey(group[0]!.search!, e.entityKey).toString(),
      )) === 1
    )
      matched.push(...group);
  if (matched.length === 0) return;
  return () =>
    Promise.all(
      matched.map((sub) =>
        receipts.fire(sub, e.entityKey, "matched", e.blockNumber, {
          creator: e.owner,
          owner: e.owner, // creator = owner at birth
        }),
      ),
    ).then(throwIfFailed); // never offered again: a failed fire throws, the dispatcher retries
}

let lastCapWarning = 0;
// Once a minute at most: the cap bites on every created entity while it holds.
function warnCapped(n: number) {
  if (Date.now() - lastCapWarning < 60_000) return;
  lastCapWarning = Date.now();
  console.warn(
    `[match] ${n} new_match subscriptions; evaluating the oldest ${MATCH_SUBS_PER_EVENT} per event`,
  );
}
