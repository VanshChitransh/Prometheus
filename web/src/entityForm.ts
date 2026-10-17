// Form values → a draft subscription entity → createEntity params. The draft is what
// decodeSubscription checks, and the params are derived from it, so what is validated is exactly
// what gets signed. Pure: no DOM, no network.
import type { CreateEntityParameters } from "@arkiv-network/sdk";
import { key, u64 } from "@arkiv-network/sdk/attr";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { hexToBytes, stringToHex, zeroHash, type Hex } from "viem";
import type { RawEntity } from "../../shared/arkiv.ts";
import { BLOCKS_PER_DAY, PROJECT, type Trigger } from "../../shared/schema.ts";

export const BLOCKS_PER_MINUTE = 30; // a block every 2 s

// Blocks → "~5 min" / "~3 h" / "~2 d".
export function span(blocks: bigint) {
  const min = Number(blocks) / BLOCKS_PER_MINUTE;
  if (min < 90) return `~${Math.max(1, Math.round(min))} min`;
  if (min < 48 * 60) return `~${Math.round(min / 60)} h`;
  return `~${Math.round(min / 1440)} d`;
}

export type FormValues = {
  trigger: Trigger;
  targetKey: string;
  leadMinutes: number;
  keepHours: number;
  termDays: number;
  label: string;
  publicMonitor: boolean;
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
    target_key: v.targetKey.trim(),
  };
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
    payload: stringToHex(JSON.stringify({ v: 1, label: v.label.trim() })),
  };
}

// Only call on a draft decodeSubscription accepted: key() throws on a malformed target_key.
export const toParams = (
  d: RawEntity,
  termDays: number,
): CreateEntityParameters => ({
  payload: hexToBytes(d.payload!),
  contentType: "application/json",
  // Bare strings are stored as str; numbers and keys need their Arkiv types (the #113 trap).
  attributes: Object.fromEntries(
    Object.entries(d.attributes).map(([n, x]) => [
      n,
      typeof x === "bigint" ? u64(x) : n === "target_key" ? key(x as Hex) : x,
    ]),
  ),
  flags: { permissionlessExtension: d.flags.permissionlessExtension },
  expires: ExpirationTime.fromDays(termDays),
});
