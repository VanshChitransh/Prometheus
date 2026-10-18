// Trusted receipts and our entities, read straight from Arkiv (no backend). Used by /s, /mine and
// /coverage; ui/Receipts.tsx draws them.
import { addr } from "@arkiv-network/sdk/attr";
import { eq, MAX_LIMIT, or, type Expression } from "@arkiv-network/sdk/query";
import { getAddress } from "viem";
import { rawGetEntity, type RawEntity } from "../../shared/arkiv.ts";
import { inBatches } from "../../shared/limit.ts";
import { parseReceipt } from "../../shared/receipt.ts";
import {
  PROJECT,
  type Event,
  type KeepSkipReason,
} from "../../shared/schema.ts";
import { reader } from "./wallet.ts";

declare const __TRUSTED_WORKERS__: string; // vite.config.ts

// Checksummed, like rawGetEntity's creators, so parseReceipt's includes() matches.
export const TRUSTED = __TRUSTED_WORKERS__
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean)
  .map((a) => getAddress(a));

export const EXPLORER = "https://tiramisu.explorer.arkiv.network"; // /entity/<key>, /address/<a>

// Every live entity matching `where`: one paid query per page of up to 200 keys, then a free read
// per key, so callers decode exactly what the workers decode.
export async function fetchEntities(...where: Expression[]) {
  let page = await reader
    .select({ key: true })
    .where(eq("project", PROJECT), ...where)
    .limit(MAX_LIMIT)
    .fetch();
  const out: RawEntity[] = [];
  for (;;) {
    const entities = await inBatches(page.entities, (e) =>
      rawGetEntity(reader, e.key),
    );
    for (const e of entities) if (e) out.push(e); // null: expired between the query and the read
    if (!page.hasNextPage()) break;
    page = await page.next();
  }
  return out;
}

// The $creator filter keeps forged receipts out of the pages; parseReceipt checks again. Newest first.
export async function fetchReceipts(...where: Expression[]) {
  if (!TRUSTED.length)
    throw new Error("This site has no trusted workers configured.");
  const entities = await fetchEntities(
    eq("kind", "receipt"),
    or(TRUSTED.map((a) => eq("$creator", addr(a)))),
    ...where,
  );
  return entities
    .map((e) => parseReceipt(e, TRUSTED))
    .filter((r) => r !== null)
    .sort((a, b) => (a.triggerBlock < b.triggerBlock ? 1 : -1));
}

export const EVENT_TEXT: Record<Event, string> = {
  warned: "Warning sent",
  expired: "Not renewed", // + "by block X" (LLD §2.3 wording)
  patched: "Changed",
  owner_changed: "Owner changed",
  deleted: "Deleted",
  matched: "New matching record",
  kept: "Kept alive",
  keep_skipped: "Renewal skipped",
  keep_failed: "Renewal failed",
  keeper_low_funds: "Worker low on funds",
};

export const SKIP_TEXT: Record<KeepSkipReason, string> = {
  not_permissionless: "only its owner may renew it",
  deny_listed: "it looks like a canary or heartbeat",
  already_extended: "someone already renewed it",
  already_expired: "it had already expired",
  budget: "the worker's daily keep budget was spent",
};
