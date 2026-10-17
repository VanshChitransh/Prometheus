// Receipts as an inset list, newest first: what happened, when, how late, the proof.
import {
  AlertTriangle,
  BellRing,
  ExternalLink,
  Flame,
  GitCompareArrows,
  Hourglass,
  ScanSearch,
  SkipForward,
  Trash2,
  UserRoundCog,
  WalletMinimal,
  type LucideIcon,
} from "lucide-react";
import type { Receipt } from "../../../shared/receipt.ts";
import type { Event, KeepSkipReason } from "../../../shared/schema.ts";
import { EVENT_TEXT, EXPLORER, SKIP_TEXT } from "../receipts.ts";
import { ago, cx, duration, Group, num, Row } from "./kit.tsx";

type Tone = "ok" | "warn" | "bad" | "accent" | "muted";
export const EVENT_STYLE: Record<Event, [LucideIcon, Tone]> = {
  warned: [BellRing, "warn"],
  expired: [Hourglass, "bad"],
  patched: [GitCompareArrows, "accent"],
  owner_changed: [UserRoundCog, "accent"],
  deleted: [Trash2, "bad"],
  matched: [ScanSearch, "accent"],
  kept: [Flame, "ok"],
  keep_skipped: [SkipForward, "warn"],
  keep_failed: [AlertTriangle, "bad"],
  keeper_low_funds: [WalletMinimal, "warn"],
};
const GLYPH: Record<Tone, string> = {
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn",
  bad: "bg-bad/12 text-bad",
  accent: "bg-accent-soft text-accent",
  muted: "bg-fill text-ink-2",
};

export function EventGlyph({
  event,
  className,
}: {
  event: Event;
  className?: string;
}) {
  const [Icon, tone] = EVENT_STYLE[event];
  return (
    <span
      className={cx(
        "grid size-8 shrink-0 place-items-center rounded-full",
        GLYPH[tone],
        className,
      )}
    >
      <Icon className="size-4" strokeWidth={2} />
    </span>
  );
}

// "on time" for the block it fired in or the next; otherwise how long it took, in clock time.
export const lateness = (late: bigint | undefined) =>
  late === undefined
    ? "lateness unknown"
    : late <= 1n
      ? "on time"
      : `${duration(late)} late`;

export function receiptTitle(r: Receipt) {
  const what =
    r.event === "expired"
      ? `${EVENT_TEXT.expired} by block ${num(r.triggerBlock)}`
      : EVENT_TEXT[r.event];
  const why =
    r.note && r.event === "keep_skipped"
      ? (SKIP_TEXT[r.note as KeepSkipReason] ?? r.note)
      : r.note;
  return { what, why };
}

export function Receipts({ list, head }: { list: Receipt[]; head: bigint }) {
  if (!list.length)
    return (
      <Group>
        <div className="px-4 py-8 text-center">
          <p className="font-medium">No receipts yet</p>
          <p className="mt-1 text-[13px] text-ink-2">
            A worker writes one the moment the trigger fires.
          </p>
        </div>
      </Group>
    );
  return (
    <Group>
      {list.map((r) => {
        const { what, why } = receiptTitle(r);
        const late =
          r.doneBlock === undefined ? undefined : r.doneBlock - r.triggerBlock;
        return (
          <Row key={r.key} inset={60} className="items-start">
            <EventGlyph event={r.event} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{what}</div>
              {why && (
                <div className="text-[13px] text-ink-2">
                  {why[0].toUpperCase() + why.slice(1)}.
                </div>
              )}
              <div className="tnum mt-1 text-[13px] text-ink-2">
                {ago(head - r.triggerBlock)}, {lateness(late)}
              </div>
            </div>
            <a
              href={`${EXPLORER}/entity/${r.key}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 flex shrink-0 items-center gap-1 text-[13px] text-accent transition-opacity hover:opacity-70"
            >
              View transaction <ExternalLink className="size-3" />
            </a>
          </Row>
        );
      })}
    </Group>
  );
}
