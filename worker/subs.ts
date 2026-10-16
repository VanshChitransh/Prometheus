// Every valid subscription this worker serves, and who watches each target (LLD §3.1, §3.2 step 2,
// §3.8). In memory and rebuildable: the truth is the subscription entities on Arkiv. Node only.
import type { PublicArkivClient } from "@arkiv-network/sdk";
import { eq, MAX_LIMIT } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { rawGetEntity } from "../shared/arkiv.ts";
import { PROJECT } from "../shared/schema.ts";
import { decodeSubscription, type Sub } from "../shared/subscription.ts";

const CAP_PER_CREATOR = 20; // LLD §3.8: beyond it, the newest are ignored
const OVER_CAP = `over the ${CAP_PER_CREATOR}-per-creator cap`;

export type AddResult =
  { ok: true; evicted?: Sub } | { ok: false; reason: string };

// Event keys arrive lowercase; a target_key attribute may not. Index everything lowercase.
const lower = (k: Hex) => k.toLowerCase() as Hex;

// Older first: creation block, then key, so every worker keeps the same 20.
const older = (a: Sub, b: Sub) =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.key < b.key);

export class SubsIndex {
  readonly #subs = new Map<Hex, Sub>();
  readonly #byTarget = new Map<Hex, Set<Hex>>(); // the reverse index for events
  readonly #byCreator = new Map<Hex, Set<Hex>>();

  get size() {
    return this.#subs.size;
  }

  // Keeps each creator's 20 oldest whatever order subscriptions arrive in: an older one evicts the
  // newest. ponytail: an evicted sub isn't promoted when one of the 20 goes away; the hourly
  // re-discovery (a fresh index) brings it back. Promote here if that hour starts to matter.
  add(sub: Sub): AddResult {
    this.remove(sub.key); // the same subscription seen twice (discovery + live) replaces itself
    const mine = this.#byCreator.get(sub.creator);
    let evicted: Sub | undefined;
    if (mine && mine.size >= CAP_PER_CREATOR) {
      const newest = [...mine]
        .map((k) => this.#subs.get(k)!)
        .reduce((a, b) => (older(a, b) ? b : a));
      if (older(newest, sub)) return { ok: false, reason: OVER_CAP };
      evicted = this.remove(newest.key);
    }
    const id = lower(sub.key);
    this.#subs.set(id, sub);
    if (sub.targetKey) link(this.#byTarget, lower(sub.targetKey), id);
    link(this.#byCreator, sub.creator, id);
    return { ok: true, evicted };
  }

  remove(key: Hex): Sub | undefined {
    const id = lower(key);
    const sub = this.#subs.get(id);
    if (!sub) return undefined;
    this.#subs.delete(id);
    if (sub.targetKey) unlink(this.#byTarget, lower(sub.targetKey), id);
    unlink(this.#byCreator, sub.creator, id);
    return sub;
  }

  get(key: Hex): Sub | undefined {
    return this.#subs.get(lower(key));
  }

  forTarget(target: Hex): Sub[] {
    return this.#pick(this.#byTarget.get(lower(target)));
  }

  byCreator(creator: Hex): Sub[] {
    return this.#pick(this.#byCreator.get(creator));
  }

  all(): Sub[] {
    return [...this.#subs.values()];
  }

  #pick(keys: Set<Hex> | undefined): Sub[] {
    return keys ? [...keys].map((k) => this.#subs.get(k)!) : [];
  }
}

function link(map: Map<Hex, Set<Hex>>, k: Hex, id: Hex) {
  const set = map.get(k);
  if (set) set.add(id);
  else map.set(k, new Set([id]));
}

// Drops empty sets, so a long-running worker's maps don't grow with every target it ever saw.
function unlink(map: Map<Hex, Set<Hex>>, k: Hex, id: Hex) {
  const set = map.get(k);
  set?.delete(id);
  if (set?.size === 0) map.delete(k);
}

// A fresh index of every live, valid subscription; the hourly re-sync swaps it in whole. The paid
// query lists keys only; each entity is then a free raw read, decoded exactly as the web form does.
// A failed read throws: starting with a partial set would silently drop subscriptions.
export async function discoverAll(
  client: PublicArkivClient,
): Promise<SubsIndex> {
  const index = new SubsIndex();
  const reasons = new Map<string, number>();
  const reject = (reason: string) =>
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

  let page = await client
    .select({ key: true })
    .where(eq("project", PROJECT), eq("kind", "subscription"))
    .limit(MAX_LIMIT)
    .fetch();
  for (;;) {
    const entities = await Promise.all(
      page.entities.map((e) => rawGetEntity(client, e.key)),
    );
    for (const e of entities) {
      if (!e) continue; // expired between the query and the read
      const d = decodeSubscription(e);
      if (!d.ok) reject(d.reason);
      else {
        const r = index.add(d.sub);
        if (!r.ok) reject(r.reason);
        else if (r.evicted) reject(OVER_CAP);
      }
    }
    if (!page.hasNextPage()) break;
    page = await page.next();
  }

  const rejected = [...reasons.values()].reduce((a, b) => a + b, 0);
  const why = [...reasons].map(([r, n]) => `${r} ×${n}`).join(", ");
  console.log(
    `[subs] ${index.size} subscriptions, ${rejected} rejected${rejected ? ` (${why})` : ""}`,
  );
  return index;
}
