// On-chain vocabulary, mirrored from arkiv/schema.md (that file wins on any disagreement).
// `as const` arrays, not enums: usable at runtime (validation) and as types. Browser-safe: no imports.

// Every entity we write carries project = PROJECT, so every query is scoped to our data (LLD §2).
export const PROJECT = "prometheus";

export const KIND = ["worker", "subscription", "receipt"] as const;
export type Kind = (typeof KIND)[number];

export const TRIGGERS = [
  "expiring",
  "expired",
  "changed",
  "new_match",
  "keep",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

// What a receipt says happened (LLD §2.3).
export const EVENTS = [
  "warned",
  "expired",
  "patched",
  "owner_changed",
  "deleted",
  "matched",
  "kept",
  "keep_skipped",
  "keep_failed",
  "keeper_low_funds",
] as const;
export type Event = (typeof EVENTS)[number];

// The `note` on a keep_skipped receipt.
export const KEEP_SKIP_REASONS = [
  "not_permissionless",
  "deny_listed",
  "already_extended",
  "already_expired",
  "budget", // the worker's daily keep budget is spent
] as const;
export type KeepSkipReason = (typeof KEEP_SKIP_REASONS)[number];

// Tiramisu makes a block every 2 s.
export const BLOCKS_PER_DAY = 43_200;

// keep_blocks > lead_blocks compares two fields, so it is checked in subscription.ts, not here.
export const BOUNDS = {
  leadBlocks: { min: 30, max: BLOCKS_PER_DAY },
  keepBlocksMax: 30 * BLOCKS_PER_DAY,
  // At least 1 h per extension: a keep every few blocks would burn a worker's gas for one target.
  keepBlocksMin: BLOCKS_PER_DAY / 24,
  maxPerDay: { default: 20, max: 100 },
  subsPerCreator: 20,
  search: { depth: 3, predicates: 8 },
  // The bot prints labels verbatim, so one line and short (the web form's maxLength).
  labelMax: 80,
} as const;

// Plain numbers; callers wrap them in ExpirationTime.fromMinutes / fromDays.
export const LIFETIMES = {
  workerMinutes: 30,
  receiptDays: 30,
  subscriptionDays: [1, 7, 30],
} as const;

// Abuse limits (audit M4, M5): extends one worker pays for per UTC day, and new_match subscriptions
// evaluated per created entity (oldest first).
export const KEEP_BUDGET_PER_DAY = 200;
export const MATCH_SUBS_PER_EVENT = 50;

// Targets the keeper never extends: these are meant to expire when their owner stops.
export const DENY_LIST =
  /canary|heart.?beat|liveness|dead.?man|keep.?alive|watchdog/i;
