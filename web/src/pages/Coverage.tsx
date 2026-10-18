// #/coverage, "Activity" (T4.6, LLD §7): what fired in the last day and the on-chain proof of each,
// read straight from Arkiv. Clients see one feed; which worker delivered it is folded away for the
// operator. Each section loads on its own, so a rate-limited query blanks only its section.
import { u64 } from "@arkiv-network/sdk/attr";
import { eq, gte } from "@arkiv-network/sdk/query";
import { ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { Hex } from "viem";
import {
  freeCount,
  rawGetEntity,
  trustedFilter,
} from "../../../shared/arkiv.ts";
import { inBatches } from "../../../shared/limit.ts";
import { BLOCKS_PER_DAY, PROJECT, type Event } from "../../../shared/schema.ts";
import { decodeSubscription } from "../../../shared/subscription.ts";
import {
  bySubscription,
  expiredGaps,
  groupByTrigger,
  summarize,
  typicalLate,
  type SubActivity,
  type TriggerRow,
  type WorkerStat,
} from "../coverage.ts";
import {
  EVENT_TEXT,
  EXPLORER,
  fetchEntities,
  fetchReceipts,
  TRUSTED,
} from "../receipts.ts";
import {
  ago,
  Badge,
  BlocksLoader,
  Button,
  cx,
  Dot,
  duration,
  ErrorText,
  Group,
  Hash,
  num,
  PageHead,
  Row,
  useLoad,
} from "../ui/kit.tsx";
import { EventGlyph } from "../ui/Receipts.tsx";
import { reader } from "../wallet.ts";

// A worker's heartbeat entity lapses within 30 min of it stopping (LLD §2.1): free count per worker.
export const liveness = () =>
  Promise.all(
    TRUSTED.map(
      async (a) =>
        (await freeCount(
          reader,
          `project = str('${PROJECT}') AND kind = str('worker') AND $creator = addr(${a})`,
        )) > 0,
    ),
  );

// Live `expired` subscriptions → is the target gone, and did a trusted worker write its receipt?
// ponytail: a creator's subscriptions past the 20-cap are never served and would show here as gaps;
// filter them with SubsIndex if that ever happens outside tests.
async function expiredChecks() {
  const trusted = trustedFilter(TRUSTED);
  const subs = (
    await fetchEntities(eq("kind", "subscription"), eq("trigger", "expired"))
  )
    .map(decodeSubscription)
    .flatMap((d) => (d.ok ? [d.sub] : []));
  return inBatches(subs, async (sub) => {
    const targetLive = !!(await rawGetEntity(reader, sub.targetKey!));
    const receipts = targetLive
      ? 0
      : await freeCount(
          reader,
          `project = str('${PROJECT}') AND kind = str('receipt') AND subscription = key(${sub.key}) AND event = str('expired') AND ${trusted}`,
        );
    return { sub, targetLive, receipts };
  });
}

async function load() {
  const head = await reader.getBlockNumber();
  const [receipts, live] = await Promise.all([
    fetchReceipts(gte("trigger_block", u64(head - BigInt(BLOCKS_PER_DAY)))),
    liveness(),
  ]);
  const rows = groupByTrigger(receipts);
  // Free reads, one per subscription in the feed: a name reads better than a key.
  const keys = [...new Set(rows.map((r) => r.subscription.toLowerCase()))];
  const labels = new Map<string, string>();
  await inBatches(keys, async (k) => {
    const e = await rawGetEntity(reader, k as Hex);
    const d = e && decodeSubscription(e);
    if (d?.ok) labels.set(k, d.sub.label);
  });
  return {
    head,
    rows,
    labels,
    workers: summarize(receipts, rows, TRUSTED, live),
  };
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${num(n)} ${n === 1 ? one : many}`;

export function Coverage() {
  const data = useLoad(load, []);
  const gaps = useLoad(async () => expiredGaps(await expiredChecks()), []);

  if (!TRUSTED.length)
    return <ErrorText error="This site has no trusted workers configured." />;
  const d = data.data;
  // One worker is enough to deliver: the client only needs to know whether anything is.
  const running = d?.workers.some((w) => w.live);

  return (
    <div className="space-y-12">
      <PageHead
        title="Activity"
        sub="What Prometheus did for every watched record in the last 24 hours. Each one links to its transaction on Arkiv, so you can check it yourself."
        right={
          d && (
            <Badge
              tone={running ? "ok" : "bad"}
              className="h-8 px-3.5 text-[13px]"
            >
              <Dot tone={running ? "ok" : "bad"} live={running} />
              {running ? "Running" : "Delivery is down"}
            </Badge>
          )
        }
      />

      {data.error ? (
        <ErrorText error={data.error} />
      ) : !d ? (
        <Group>
          <BlocksLoader label="Reading the last 24 hours from Arkiv…" />
        </Group>
      ) : (
        <Summary rows={d.rows} missed={gaps.data?.length} />
      )}

      {/* Both reads hit the same node: one error line is enough. */}
      {gaps.error && !data.error ? (
        <ErrorText error={gaps.error} />
      ) : (
        !!gaps.data?.length && (
          <Group
            title={`Missed (${num(gaps.data.length)})`}
            note="Records that expired without their alert. One that expired in the last minute can show here until its alert lands."
          >
            {gaps.data.map((s) => (
              <Row key={s.key} className="justify-between">
                <a
                  href={`#/s/${s.key}`}
                  className="font-medium hover:text-accent"
                >
                  {s.label || "Untitled"}
                </a>
                <Hash
                  value={s.targetKey!}
                  href={`${EXPLORER}/entity/${s.targetKey}`}
                />
              </Row>
            ))}
          </Group>
        )
      )}

      {d && <Feed rows={d.rows} head={d.head} labels={d.labels} />}

      {d && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-4 text-[13px] font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 transition-transform duration-150 group-open:rotate-90" />
            Under the hood
          </summary>
          <Group
            className="mt-2"
            note="Worker A acts first; B waits and acts only on what A missed. Each proves it's alive with a heartbeat entity on Arkiv that lapses within 30 minutes if it stops."
          >
            {d.workers.map((w, i) => (
              <WorkerRow key={w.address} w={w} i={i} />
            ))}
          </Group>
        </details>
      )}
    </div>
  );
}

// What the workers did, in words: [events, verb, noun] → "sent 14 expiry warnings".
const DID: [Event[], string, string, string][] = [
  [["kept"], "kept records alive", "time", "times"],
  [["warned"], "sent", "expiry warning", "expiry warnings"],
  [["expired"], "reported", "expiry", "expiries"],
  [["patched", "owner_changed", "deleted"], "caught", "change", "changes"],
  [["matched"], "found", "new match", "new matches"],
  [["keep_skipped", "keep_failed"], "skipped", "renewal", "renewals"],
];

// The headline as a sentence: the type is the display (frontend-design: not stat tiles).
function Summary({ rows, missed }: { rows: TriggerRow[]; missed?: number }) {
  const b = (v: string | number) => (
    <span className="tnum font-semibold text-ink">{v}</span>
  );
  const parts = DID.flatMap(([events, verb, one, many]) => {
    const n = rows.filter((r) => events.includes(r.event)).length;
    if (!n) return [];
    return [
      <>
        {verb} {b(num(n))} {n === 1 ? one : many}
      </>,
    ];
  });
  const late = typicalLate(rows);
  return (
    <div>
      <p className="max-w-[34ch] text-[26px] leading-[1.32] font-medium tracking-[-0.02em] text-ink-2 sm:text-[34px]">
        {parts.length ? (
          <>
            In the last day we{" "}
            {parts.map((p, i) => (
              <span key={i}>
                {i === 0 ? "" : i === parts.length - 1 ? " and " : ", "}
                {p}
              </span>
            ))}
            .{" "}
          </>
        ) : (
          "Nothing needed doing in the last day. "
        )}
        {missed === undefined ? (
          "…"
        ) : missed ? (
          <>{b(plural(missed, "alert"))} missed.</>
        ) : (
          <>{b("Nothing")} missed.</>
        )}
      </p>
      {late !== undefined && (
        <p className="mt-3 text-[15px] text-ink-2">
          Each one usually lands within {duration(late > 1n ? late : 1n)} of the
          change on chain.
        </p>
      )}
    </div>
  );
}

function WorkerRow({ w, i }: { w: WorkerStat; i: number }) {
  const late = (l: bigint | undefined) => (l === undefined ? "–" : num(l));
  return (
    <Row inset={64} className="items-start py-4">
      <span
        className={cx(
          "grid size-9 shrink-0 place-items-center rounded-full text-[15px] font-semibold",
          i === 0 ? "bg-fill text-ink" : "bg-accent-soft text-accent",
        )}
      >
        {w.name}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">Worker {w.name}</span>
          <span className="text-[13px] text-ink-2">
            {i === 0 ? "Acts first" : "Waits, then covers what A missed"}
          </span>
        </div>
        <div className="tnum mt-1 text-[13px] text-ink-2">
          {plural(w.delivered, "delivery", "deliveries")}, {num(w.only)} only by{" "}
          {w.name}. Late by {late(w.medianLate)} blocks typically,{" "}
          {late(w.maxLate)} at most.
        </div>
        <Hash
          value={w.address}
          href={`${EXPLORER}/address/${w.address}`}
          className="mt-1 -ml-0.5"
        />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span
          className={cx(
            "flex items-center gap-1.5 text-[13px] font-medium",
            w.live ? "text-ok" : "text-bad",
          )}
        >
          <Dot tone={w.live ? "ok" : "bad"} live={w.live} />
          {w.live ? "Live" : "Offline"}
        </span>
        {w.lowFunds && <Badge tone="warn">Low on funds</Badge>}
      </div>
    </Row>
  );
}

// "Kept alive ×15 · Warning sent", most frequent first.
const countsText = (counts: Map<Event, number>) =>
  [...counts]
    .sort((x, y) => y[1] - x[1])
    .map(([e, n]) => (n > 1 ? `${EVENT_TEXT[e]} ×${n}` : EVENT_TEXT[e]))
    .join(" · ");

function Feed({
  rows,
  head,
  labels,
}: {
  rows: TriggerRow[];
  head: bigint;
  labels: Map<string, string>;
}) {
  const [all, setAll] = useState(false);
  // A subscription with no live entity was cancelled or lapsed: nothing to open or name, so its
  // events become one footnote instead of rows nobody can make sense of.
  const subs = bySubscription(rows);
  const live = subs.filter((s) => labels.has(s.subscription.toLowerCase()));
  const ended = rows.filter(
    (r) => !labels.has(r.subscription.toLowerCase()),
  ).length;
  const shown = all ? live : live.slice(0, 10);
  return (
    <Group
      title={`Watched records (${num(live.length)})`}
      note={
        ended > 0 &&
        `Plus ${plural(ended, "event")} for subscriptions that have since ended.`
      }
      right={
        live.length > 10 && (
          <Button
            variant="plain"
            size="sm"
            className="h-auto px-0"
            onClick={() => setAll(!all)}
          >
            {all ? "Show fewer" : `Show all ${num(live.length)}`}
          </Button>
        )
      }
    >
      {!live.length ? (
        <Row>
          <span className="text-ink-2">Nothing in the last 24 hours.</span>
        </Row>
      ) : (
        shown.map((s) => (
          <SubRow
            key={s.subscription}
            s={s}
            head={head}
            label={labels.get(s.subscription.toLowerCase())!}
          />
        ))
      )}
    </Group>
  );
}

function SubRow({
  s,
  head,
  label,
}: {
  s: SubActivity;
  head: bigint;
  label: string;
}) {
  return (
    <Row inset={60}>
      <EventGlyph event={s.latest.event} />
      <div className="min-w-0 flex-1">
        <a
          href={`#/s/${s.subscription}`}
          className="block truncate font-medium hover:text-accent"
        >
          {label}
        </a>
        <div className="tnum truncate text-[13px] text-ink-2">
          {countsText(s.counts)} · {ago(head - s.latest.triggerBlock)}
        </div>
      </div>
      <a
        href={`${EXPLORER}/entity/${s.latest.key}`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Latest transaction for ${label}`}
        className="flex shrink-0 items-center gap-1 text-[13px] text-accent transition-opacity hover:opacity-70"
      >
        Proof
        <ExternalLink className="size-3" />
      </a>
    </Row>
  );
}
