// Trusted receipts, read straight from Arkiv (no backend) and drawn as a table. Used by #/s and
// #/coverage.
import { addr } from "@arkiv-network/sdk/attr";
import { eq, MAX_LIMIT, or, type Expression } from "@arkiv-network/sdk/query";
import { getAddress, type Hex } from "viem";
import { rawGetEntity } from "../../shared/arkiv.ts";
import { inBatches } from "../../shared/limit.ts";
import { parseReceipt, type Receipt } from "../../shared/receipt.ts";
import {
  PROJECT,
  type Event,
  type KeepSkipReason,
} from "../../shared/schema.ts";
import { link } from "./router.ts";
import { reader } from "./wallet.ts";

declare const __TRUSTED_WORKERS__: string; // vite.config.ts

// Checksummed, like rawGetEntity's creators, so parseReceipt's includes() matches.
export const TRUSTED = __TRUSTED_WORKERS__
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean)
  .map((a) => getAddress(a));

export const EXPLORER = "https://tiramisu.explorer.arkiv.network"; // /entity/<key>, /address/<a>

// One paid query per page of up to 200 keys, then a free read per key, decoded by the same parser
// the relay uses. The $creator filter keeps forged receipts out of the pages; parseReceipt checks again.
export async function fetchReceipts(...where: Expression[]) {
  if (!TRUSTED.length)
    throw new Error("This site has no trusted workers configured.");
  let page = await reader
    .select({ key: true })
    .where(
      eq("project", PROJECT),
      eq("kind", "receipt"),
      or(TRUSTED.map((a) => eq("$creator", addr(a)))),
      ...where,
    )
    .limit(MAX_LIMIT)
    .fetch();
  const out: Receipt[] = [];
  for (;;) {
    const entities = await inBatches(page.entities, (e) =>
      rawGetEntity(reader, e.key),
    );
    for (const e of entities) {
      const r = e && parseReceipt(e, TRUSTED); // null: expired between the query and the read
      if (r) out.push(r);
    }
    if (!page.hasNextPage()) break;
    page = await page.next();
  }
  return out.sort((a, b) => (a.triggerBlock < b.triggerBlock ? 1 : -1)); // newest first
}

const EVENT_TEXT: Record<Event, string> = {
  warned: "Warned: expiring soon",
  expired: "Not renewed", // + "by block X" (LLD §2.3 wording)
  patched: "Changed",
  owner_changed: "Owner changed",
  deleted: "Deleted",
  matched: "New match",
  kept: "Kept alive",
  keep_skipped: "Keep skipped",
  keep_failed: "Keep failed",
  keeper_low_funds: "Worker low on funds",
};

const SKIP_TEXT: Record<KeepSkipReason, string> = {
  not_permissionless: "only its owner may renew it",
  deny_listed: "it looks like a canary or heartbeat",
  already_extended: "someone already renewed it",
  already_expired: "it had already expired",
  budget: "the worker's daily keep budget was spent",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addressLink = (a: Hex) => link(`${EXPLORER}/address/${a}`, short(a));

function row(r: Receipt) {
  const what =
    r.event === "expired"
      ? `${EVENT_TEXT.expired} by block ${r.triggerBlock}`
      : EVENT_TEXT[r.event];
  const why =
    r.note && r.event === "keep_skipped"
      ? (SKIP_TEXT[r.note as KeepSkipReason] ?? r.note)
      : r.note;
  const late =
    r.doneBlock === undefined ? undefined : r.doneBlock - r.triggerBlock;
  const target = document.createElement("span");
  if (r.targetCreator) target.append("creator ", addressLink(r.targetCreator));
  if (r.targetOwner) target.append(" · owner ", addressLink(r.targetOwner));
  const cells: (string | Node)[] = [
    why ? `${what}: ${why}` : what,
    String(r.triggerBlock),
    late === undefined ? "?" : `${late} blocks (~${late * 2n} s)`,
    addressLink(r.creator),
    target,
    link(`${EXPLORER}/entity/${r.key}`, "receipt"),
  ];
  const tr = document.createElement("tr");
  for (const c of cells) {
    const td = document.createElement("td");
    td.append(c); // strings become text nodes: on-chain notes can't inject markup
    tr.append(td);
  }
  return tr;
}

export function renderReceipts(list: Receipt[]) {
  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Written by trusted workers. Receipts can't be rewritten; deletion is publicly logged.";
  if (!list.length) {
    const none = document.createElement("p");
    none.textContent =
      "No receipts yet. A worker writes one when the trigger fires.";
    return [note, none];
  }
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>Event</th><th>Trigger block</th><th>Late</th><th>Worker</th><th>Target as seen</th><th></th></tr></thead>";
  const body = document.createElement("tbody");
  body.append(...list.map(row));
  table.append(body);
  return [note, table];
}
