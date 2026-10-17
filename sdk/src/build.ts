// Options → the exact createEntity params the web form signs (web/src/entityForm.ts), checked by the
// workers' own decodeSubscription. Pure: no network, so every rule here is unit-tested.
import type { CreateEntityParameters } from "@arkiv-network/sdk";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import type { Hex } from "viem";
import { BOUNDS, type Trigger } from "../../shared/schema.ts";
import { parseSearch } from "../../shared/searchAst.ts";
import { decodeSubscription } from "../../shared/subscription.ts";
import {
  BLOCKS_PER_MINUTE,
  toDraft,
  toParams,
  toSearch,
} from "../../web/src/entityForm.ts";

/** "30s", "10m", "1h", "7d": a whole number of 2-second blocks. */
export type Duration = `${number}${"s" | "m" | "h" | "d"}`;

export type ErrorCode =
  | "bad_duration"
  | "bad_label"
  | "bad_target"
  | "bad_before"
  | "bad_extend_by"
  | "bad_where"
  | "bad_created_by"
  | "bad_key"
  | "no_account"
  | "target_not_found"
  | "keep_blocked"
  | "too_many_subscriptions"
  | "no_funds"
  | "not_found"
  | "not_owner"
  | "renew_too_short"
  | "rejected";

export class PrometheusError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "PrometheusError";
    this.code = code;
  }
}

const SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;
const SECONDS_PER_BLOCK = 2;

export function blocksOf(d: unknown, name: string): bigint {
  const m = typeof d === "string" ? /^([1-9]\d*)([smhd])$/.exec(d) : null;
  const s = m ? Number(m[1]) * SECONDS[m[2] as keyof typeof SECONDS] : NaN;
  if (!Number.isSafeInteger(s) || s % SECONDS_PER_BLOCK)
    throw new PrometheusError(
      "bad_duration",
      `\`${name}\` must be a duration like "30s", "10m", "1h" or "7d" (whole 2-second blocks), got ${typeof d === "string" ? `"${d}"` : String(d)}.`,
    );
  return BigInt(s / SECONDS_PER_BLOCK);
}

// Blocks → the largest unit that divides them evenly: 30 → "1m", 1_296_000 → "30d".
const asDuration = (blocks: number): Duration => {
  const s = blocks * SECONDS_PER_BLOCK;
  const [u, n] = Object.entries(SECONDS)
    .reverse()
    .find(([, n]) => s % n === 0)!;
  return `${s / n}${u}` as Duration;
};

/** What workers accept, in the units the options use. */
export const LIMITS = {
  labelMaxLength: 80, // the web form's maxLength
  before: {
    min: asDuration(BOUNDS.leadBlocks.min),
    max: asDuration(BOUNDS.leadBlocks.max),
  },
  extendBy: {
    min: asDuration(BOUNDS.keepBlocksMin),
    max: asDuration(BOUNDS.keepBlocksMax),
  },
  subscriptionsPerWallet: BOUNDS.subsPerCreator,
  whereMaxConditions: BOUNDS.search.predicates,
} as const;

// The worker's reasons name attributes (lead_blocks…); say them in the options' own words.
// Same table as web/src/pages/New.tsx's REASONS, worded for code instead of the form.
// prettier-ignore
const REASONS: [RegExp, ErrorCode, string][] = [
  [/^label is required/, "bad_label", "Add a label. It's how you'll recognise the alert."],
  [/^target_key/, "bad_target", "Pass the key of the entity to watch: 0x followed by 64 hex characters."],
  [/^lead_blocks must be/, "bad_before", "Choose `before` between 1 minute and 1 day."],
  [/^keep_blocks must be greater/, "bad_extend_by", "`extendBy` must add more time per renewal than `before`."],
  [/^keep_blocks must be at least/, "bad_extend_by", "Each renewal (`extendBy`) must add at least 1 hour."],
  [/^keep_blocks can be at most/, "bad_extend_by", "Each renewal (`extendBy`) can add at most 30 days."],
  [/^target_owner/, "bad_created_by", "`createdBy` must be an address: 0x followed by 40 hex characters."],
];

export function rejection(reason: string) {
  const hit = REASONS.find(([re]) => re.test(reason));
  return hit
    ? new PrometheusError(hit[1], hit[2])
    : new PrometheusError("rejected", `Workers would reject it: ${reason}.`);
}

/** Equality conditions: strings match as str (0x+40 hex as addr, 0x+64 hex as key), bigints as u64. */
export type Where = Record<string, string | bigint>;

const valueType = (name: string, v: unknown) => {
  if (typeof v === "bigint") return "u64";
  if (typeof v !== "string")
    throw new PrometheusError(
      "bad_where",
      `\`where.${name}\` must be a string or a bigint (numbers match as u64, so write ${String(v)}n).`,
    );
  return /^0x[0-9a-fA-F]{64}$/.test(v)
    ? "key"
    : /^0x[0-9a-fA-F]{40}$/.test(v)
      ? "addr"
      : "str";
};

// `where` → the same search tree the web form's builder writes, checked by the worker's parser.
export function whereToSearch(where: unknown): unknown {
  const entries =
    typeof where === "object" && where !== null && !Array.isArray(where)
      ? Object.entries(where)
      : [];
  if (!entries.length)
    throw new PrometheusError(
      "bad_where",
      'Pass `where` with at least one attribute, e.g. { kind: "booking" }.',
    );
  const search = toSearch(
    entries.map(([name, v]) => ({
      name,
      type: valueType(name, v),
      op: "eq",
      value: String(v),
    })),
  );
  try {
    parseSearch(search);
  } catch (e) {
    throw new PrometheusError(
      "bad_where",
      `\`where\` isn't a search workers accept: ${(e as Error).message}.`,
    );
  }
  return search;
}

export type Input = {
  target?: string;
  before?: Duration;
  extendBy?: Duration;
  for?: Duration;
  label: string;
  public?: boolean;
  where?: Where;
  createdBy?: string;
};

export function build(trigger: Trigger, i: Input, creator: Hex) {
  const label = String(i.label ?? "").trim();
  if (label.length > LIMITS.labelMaxLength)
    throw new PrometheusError(
      "bad_label",
      `Keep the label to ${LIMITS.labelMaxLength} characters or fewer.`,
    );
  const lead =
    trigger === "expiring" || trigger === "keep"
      ? blocksOf(i.before, "before")
      : 0n;
  const keep = trigger === "keep" ? blocksOf(i.extendBy, "extendBy") : 0n;
  const term = blocksOf(i.for ?? "7d", "for");
  const draft = toDraft(
    {
      trigger,
      targetKey: String(i.target ?? ""),
      leadMinutes: Number(lead) / BLOCKS_PER_MINUTE,
      keepHours: Number(keep) / (BLOCKS_PER_MINUTE * 60),
      termDays: 0, // whole days only; `for` is any duration, so the expiry is set in blocks below
      label,
      publicMonitor: i.public === true,
      search: trigger === "new_match" ? whereToSearch(i.where) : undefined,
      targetOwner: i.createdBy,
    },
    creator,
    0n, // the creation block doesn't change what workers accept
  );
  const d = decodeSubscription(draft);
  if (!d.ok) throw rejection(d.reason);
  const params: CreateEntityParameters = {
    ...toParams(draft, 1),
    expires: ExpirationTime.fromBlocks(Number(term)),
  };
  return { params, lead, term };
}
