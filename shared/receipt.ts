// Raw receipt entity → typed Receipt, or null if it isn't one we trust (LLD §2.3). Browser-safe: the
// relay's DMs, the status page and the coverage page all read receipts through this one function.
import { hexToString, type Hex } from "viem";
import type { RawEntity } from "./arkiv.ts";
import { EVENTS, PROJECT, type Event } from "./schema.ts";

export type Receipt = {
  key: Hex;
  creator: Hex; // the worker that wrote it
  triggerId: string;
  subscription: Hex;
  subject: Hex; // the watched target, or the matched entity for new_match
  event: Event;
  triggerBlock: bigint;
  doneBlock?: bigint; // done − trigger = lateness
  note?: string; // why a keep was skipped or failed
  targetCreator?: Hex; // the target as the worker saw it, pinned against a re-created namesake
  targetOwner?: Hex;
};

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// Trust comes from $creator, never from an attribute: anyone can write kind = "receipt".
// The kind check matters too: workers also create their own `worker` heartbeat entity.
export function parseReceipt(
  e: RawEntity,
  trusted: readonly Hex[],
): Receipt | null {
  const a = e.attributes;
  // Any letter case: a caller with a lowercase list silently matched nothing.
  const creator = e.creator.toLowerCase();
  if (!trusted.some((w) => w.toLowerCase() === creator)) return null;
  if (a.project !== PROJECT || a.kind !== "receipt") return null;
  const { trigger_id, subscription, subject, event, trigger_block } = a;
  if (
    typeof trigger_id !== "string" ||
    typeof subscription !== "string" ||
    typeof subject !== "string" ||
    typeof event !== "string" ||
    typeof trigger_block !== "bigint" ||
    // Every reader looks the event up in a table: an unknown one crashed the web's (audit SH-4).
    !(EVENTS as readonly string[]).includes(event)
  )
    return null;
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(hexToString(e.payload ?? "0x")) ?? {};
  } catch {} // no readable payload: the receipt still counts, without its details
  return {
    key: e.key,
    creator: e.creator,
    triggerId: trigger_id,
    subscription: subscription as Hex,
    subject: subject as Hex,
    event: event as Event,
    triggerBlock: trigger_block,
    doneBlock: typeof a.done_block === "bigint" ? a.done_block : undefined,
    note: str(p.note),
    targetCreator: str(p.target_creator) as Hex | undefined,
    targetOwner: str(p.target_owner) as Hex | undefined,
  };
}
