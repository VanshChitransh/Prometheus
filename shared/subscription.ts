// Raw subscription entity → typed Sub, or a readable reason (LLD §2.2, §3.8). Browser-safe: the web
// form shows the same reasons the worker logs, so the two can never disagree.
// Not here: the 20-per-creator cap (needs every subscription, worker/subs.ts) and "the target
// exists" (needs the network, worker).
import type { Expression } from "@arkiv-network/sdk/query";
import { checksumAddress, hexToString, isAddress, type Hex } from "viem";
import type { RawEntity } from "./arkiv.ts";
import {
  BOUNDS,
  DENY_LIST,
  PROJECT,
  TRIGGERS,
  type KeepSkipReason,
  type Trigger,
} from "./schema.ts";
import { parseSearch } from "./searchAst.ts";

export type Sub = {
  key: Hex;
  creator: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  publicMonitor: boolean; // permissionlessExtension: anyone may renew it
  trigger: Trigger;
  label: string;
  maxPerDay: number;
  targetKey?: Hex;
  targetOwner?: Hex;
  leadBlocks?: bigint;
  keepBlocks?: bigint;
  search?: Expression;
};
export type Decoded = { ok: true; sub: Sub } | { ok: false; reason: string };

const NEEDS_TARGET: readonly Trigger[] = [
  "expiring",
  "expired",
  "changed",
  "keep",
];
const NEEDS_LEAD: readonly Trigger[] = ["expiring", "keep"];

export function decodeSubscription(e: RawEntity): Decoded {
  // Untrusted input: any failure, ours or parseSearch's, becomes the rejection reason.
  try {
    return { ok: true, sub: decode(e) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

function decode(e: RawEntity): Sub {
  const a = e.attributes;
  const fail = (reason: string): never => {
    throw new Error(reason);
  };

  if (a.project !== PROJECT || a.kind !== "subscription")
    fail("not a prometheus subscription");
  const trigger = a.trigger as Trigger;
  if (!TRIGGERS.includes(trigger))
    fail(`trigger must be one of ${TRIGGERS.join(", ")}`);

  // Range-queried numbers must be u64. An i32 or u256 attribute is rejected even if in bounds,
  // because u64 queries would never match it (the #113 trap on the write side).
  const u64 = (name: string, required: boolean) => {
    const v = a[name];
    if (v === undefined)
      return required ? fail(`${name} is required for ${trigger}`) : undefined;
    return typeof v === "bigint" ? v : fail(`${name} must be a u64`);
  };

  let targetKey: Hex | undefined;
  if (NEEDS_TARGET.includes(trigger)) {
    const k = a.target_key;
    if (typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k))
      fail(`target_key (a 32-byte entity key) is required for ${trigger}`);
    targetKey = k as Hex;
  }

  let targetOwner: Hex | undefined;
  if (trigger === "new_match" && a.target_owner !== undefined) {
    const o = a.target_owner;
    // isAddress also checks a mixed-case address's checksum, as the SDK's addr() does on write.
    if (typeof o !== "string" || !isAddress(o))
      fail("target_owner must be an address");
    targetOwner = checksumAddress(o as Hex); // events report checksummed owners
  }

  const lead = u64("lead_blocks", NEEDS_LEAD.includes(trigger));
  const { min, max } = BOUNDS.leadBlocks;
  if (lead !== undefined && (lead < min || lead > max))
    fail(
      `lead_blocks must be ${min}–${max.toLocaleString("en")} (1 minute to 1 day)`,
    );

  const keep = u64("keep_blocks", trigger === "keep");
  if (keep !== undefined && keep > BOUNDS.keepBlocksMax)
    fail("keep_blocks can be at most 30 days of blocks");
  // Each extension must outrun the lead, or the target is "about to expire" again at once.
  if (trigger === "keep" && keep! <= lead!)
    fail("keep_blocks must be greater than lead_blocks");
  if (trigger === "keep" && keep! < BOUNDS.keepBlocksMin)
    fail(
      `keep_blocks must be at least ${BOUNDS.keepBlocksMin.toLocaleString("en")} (1 hour)`,
    );

  const perDay = u64("max_per_day", false) ?? BigInt(BOUNDS.maxPerDay.default);
  if (perDay < 1n || perDay > BOUNDS.maxPerDay.max)
    fail(`max_per_day must be 1–${BOUNDS.maxPerDay.max}`);

  let p: { v?: unknown; label?: unknown; search?: unknown };
  try {
    p = JSON.parse(hexToString(e.payload ?? "0x"));
  } catch {
    return fail("payload must be JSON");
  }
  if (p?.v !== 1) fail("payload version must be v: 1");
  if (typeof p.label !== "string" || !p.label.trim()) fail("label is required");
  const label = p.label as string;
  // Control characters and U+2028/9 would let a label forge extra lines in the bot's DMs.
  if (
    label.length > BOUNDS.labelMax ||
    /[\u0000-\u001f\u007f\u2028\u2029]/.test(label)
  )
    fail(`label must be one line of at most ${BOUNDS.labelMax} characters`);

  return {
    key: e.key,
    creator: e.creator,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    publicMonitor: e.flags.permissionlessExtension,
    trigger,
    label,
    maxPerDay: Number(perDay),
    targetKey,
    targetOwner,
    leadBlocks: lead,
    keepBlocks: trigger === "keep" ? keep : undefined,
    search: trigger === "new_match" ? parseSearch(p.search) : undefined,
  };
}

// Why the keeper would refuse to extend this target, or null (LLD §3.6 rules 2–3). Here, not in the
// keeper, so the web preview and the worker can never disagree. Rule 4 (already extended) depends on
// the trigger's head, so it stays in the keeper.
export function keepBlocked(
  e: RawEntity,
): Extract<KeepSkipReason, "not_permissionless" | "deny_listed"> | null {
  if (!e.flags.permissionlessExtension) return "not_permissionless";
  // ponytail: a name heuristic (nothing on chain marks a canary); the owner's real protection is
  // creating it without permissionlessExtension (LLD §3.6, known limit).
  // Our own entities too: two public subscriptions keeping each other alive would never end.
  // Each field on its own: joined, a word split across them ("undead" + "manor") matched.
  const { kind, project } = e.attributes;
  if (
    project === PROJECT ||
    [kind, project].some((v) => DENY_LIST.test(String(v ?? "")))
  )
    return "deny_listed";
  return null;
}

// Older first: creation block, then key, so every worker keeps the same 20 (LLD §3.8).
export const older = (a: Sub, b: Sub) =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.key < b.key);

// The keys workers actually serve among one creator's subscriptions: the oldest 20. Shared so
// #/mine marks the rest "not served" by the worker's own rule.
export const servedFirst = (subs: readonly Sub[]) =>
  new Set(
    [...subs]
      .sort((a, b) => (older(a, b) ? -1 : older(b, a) ? 1 : 0))
      .slice(0, BOUNDS.subsPerCreator)
      .map((s) => s.key),
  );
