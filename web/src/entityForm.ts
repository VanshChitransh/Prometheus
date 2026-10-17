// Form values → a draft subscription entity → createEntity params. The draft is what
// decodeSubscription checks, and the params are derived from it, so what is validated is exactly
// what gets signed. Pure: no DOM, no network.
import type { CreateEntityParameters } from "@arkiv-network/sdk";
import { addr, key, u64 } from "@arkiv-network/sdk/attr";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { hexToBytes, stringToHex, zeroHash, type Hex } from "viem";
import type { RawEntity } from "../../shared/arkiv.ts";
import {
  BLOCKS_PER_DAY,
  LIFETIMES,
  PROJECT,
  type Trigger,
} from "../../shared/schema.ts";

export const BLOCKS_PER_MINUTE = 30; // a block every 2 s

// Blocks → "~5 min" / "~3 h" / "~2 d".
export function span(blocks: bigint) {
  const min = Number(blocks) / BLOCKS_PER_MINUTE;
  if (min < 90) return `~${Math.max(1, Math.round(min))} min`;
  if (min < 48 * 60) return `~${Math.round(min / 60)} h`;
  return `~${Math.round(min / 1440)} d`;
}

// Renewal terms that would actually help. An extend *sets* the expiry from now, and the engine
// rejects one that wouldn't move it later, so "1 day" on a sub with 6 left would just fail.
export const renewChoices = (expiresAt: bigint, head: bigint) =>
  LIFETIMES.subscriptionDays.filter(
    (d) => head + BigInt(d * BLOCKS_PER_DAY) > expiresAt,
  );

export type FormValues = {
  trigger: Trigger;
  targetKey: string;
  leadMinutes: number;
  keepHours: number;
  termDays: number;
  label: string;
  publicMonitor: boolean;
  search?: unknown; // new_match: the JSON search tree (LLD §5)
  targetOwner?: string; // new_match: only entities created by this owner
};

// Empty or garbage numbers become 0 blocks, which decodeSubscription then rejects with its reason.
const blocks = (n: number, perUnit: number) =>
  BigInt(Math.round(n * perUnit) || 0);

// The entity as a worker would read it back. `head` stands in for the creation block.
export function toDraft(v: FormValues, creator: Hex, head: bigint): RawEntity {
  const attributes: RawEntity["attributes"] = {
    project: PROJECT,
    kind: "subscription",
    trigger: v.trigger,
  };
  if (v.trigger !== "new_match") attributes.target_key = v.targetKey.trim();
  else if (v.targetOwner) attributes.target_owner = v.targetOwner;
  if (v.trigger === "expiring" || v.trigger === "keep")
    attributes.lead_blocks = blocks(v.leadMinutes, BLOCKS_PER_MINUTE);
  if (v.trigger === "keep")
    attributes.keep_blocks = blocks(v.keepHours, BLOCKS_PER_MINUTE * 60);
  return {
    key: zeroHash, // unknown until created
    creator,
    owner: creator,
    createdAt: head,
    expiresAt: head + BigInt(v.termDays * BLOCKS_PER_DAY),
    flags: { readonly: false, permissionlessExtension: v.publicMonitor },
    attributes,
    payload: stringToHex(
      JSON.stringify({
        v: 1,
        label: v.label.trim(),
        ...(v.trigger === "new_match" && { search: v.search }),
      }),
    ),
  };
}

// Only call on a draft decodeSubscription accepted: key() and addr() throw on malformed values.
export const toParams = (
  d: RawEntity,
  termDays: number,
): CreateEntityParameters => ({
  payload: hexToBytes(d.payload!),
  contentType: "application/json",
  // Bare strings are stored as str; numbers, keys and addresses need their Arkiv types (#113).
  attributes: Object.fromEntries(
    Object.entries(d.attributes).map(([n, x]) => [
      n,
      typeof x === "bigint"
        ? u64(x)
        : n === "target_key"
          ? key(x as Hex)
          : n === "target_owner"
            ? addr(x as Hex)
            : x,
    ]),
  ),
  flags: { permissionlessExtension: d.flags.permissionlessExtension },
  expires: ExpirationTime.fromDays(termDays),
});

// --- new_match search builder (T4.3): an example entity's attributes → a search tree ---

// What the search accepts per attribute type (shared/searchAst.ts). Others (u256, dec…) can't be used.
const OPS: Record<string, readonly string[]> = {
  str: ["eq", "startsWith"],
  u64: ["eq", "gte", "lte", "gt", "lt"],
  i32: ["eq", "gte", "lte", "gt", "lt"],
  addr: ["eq"],
  key: ["eq"],
  bytes32: ["eq"],
  bool: ["eq"],
};

export type SearchRow = {
  name: string;
  type: string;
  value: string;
  ops: readonly string[]; // empty: this attribute can't be searched
};

export const searchRows = (e: RawEntity): SearchRow[] =>
  Object.entries(e.attributes)
    .map(([name, v]) => {
      const type = e.types?.[name] ?? "unknown";
      return { name, type, value: String(v), ops: OPS[type] ?? [] };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

export type Condition = {
  name: string;
  type: string;
  op: string;
  value: string;
};

// The ticked rows ANDed together. Values carry their type ({ u64: "4" }), never bare (#113);
// parseSearch then checks the tree exactly as the worker will.
export const toSearch = (conds: readonly Condition[]) => ({
  and: conds.map(({ name, type, op, value }) =>
    op === "startsWith"
      ? { startsWith: [name, value] }
      : {
          [op]: [
            name,
            {
              [type]:
                type === "i32"
                  ? Number(value)
                  : type === "bool"
                    ? ({ true: true, false: false }[value] ?? value) // garbage: parseSearch rejects it
                    : value.trim(),
            },
          ],
        },
  ),
});
