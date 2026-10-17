// #/coverage (T4.6, LLD §7): public proof of reliability and gaps, read straight from Arkiv. Each
// section loads on its own, so a rate-limited query blanks only its section.
import { u64 } from "@arkiv-network/sdk/attr";
import { eq, gte } from "@arkiv-network/sdk/query";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import type { Hex } from "viem";
import {
  freeCount,
  rawGetEntity,
  trustedFilter,
} from "../../../shared/arkiv.ts";
import { inBatches } from "../../../shared/limit.ts";
import { BLOCKS_PER_DAY, PROJECT } from "../../../shared/schema.ts";
import { decodeSubscription } from "../../../shared/subscription.ts";
import {
  expiredGaps,
  groupByTrigger,
  rowStatus,
  summarize,
  workerName,
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
  BLOCK_MS,
  BlocksLoader,
  Button,
  cx,
  Dot,
  ErrorText,
  Group,
  Hash,
  num,
  PageHead,
  Row,
  useLoad,
} from "../ui/kit.tsx";
import { EventGlyph, lateness } from "../ui/Receipts.tsx";
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
  const wall = Date.now();
  const since = head - BigInt(BLOCKS_PER_DAY);
  const [receipts, live] = await Promise.all([
    fetchReceipts(gte("trigger_block", u64(since))),
    liveness(),
  ]);
  const rows = groupByTrigger(receipts);
  return {
    head,
    wall,
    since,
    rows,
    ...summarize(receipts, rows, TRUSTED, live),
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
  const allLive = d?.workers.every((w) => w.live);

  return (
    <div className="space-y-12">
      <PageHead
        title="Coverage"
        sub="The last 24 hours, worked out in your browser from the receipts on Arkiv. You can check every number here yourself."
        right={
          d && (
            <Badge
              tone={allLive ? "ok" : "bad"}
              className="h-8 px-3.5 text-[13px]"
            >
              <Dot tone={allLive ? "ok" : "bad"} live={allLive} />
              {/* The full headline when a worker is down: "A offline · N covered by B". */}
              {allLive ? "Both workers live" : d.headline}
            </Badge>
          )
        }
      />

      {data.error ? (
        <ErrorText error={data.error} />
      ) : !d ? (
        <Group>
          <BlocksLoader label="Reading the last 24 hours of receipts from Arkiv…" />
        </Group>
      ) : (
        <>
          <Summary rows={d.rows} workers={d.workers} gaps={gaps.data?.length} />
          <Chart rows={d.rows} since={d.since} head={d.head} wall={d.wall} />
          <Group
            title="Workers"
            note="Each worker proves it's alive with a heartbeat entity on Arkiv that lapses within 30 minutes if it stops."
          >
            {d.workers.map((w, i) => (
              <WorkerRow key={w.address} w={w} i={i} />
            ))}
          </Group>
        </>
      )}

      <Group
        title="Gaps"
        note="Expired subscriptions whose target is gone with no receipt. One that expired in the last minute can show here until its receipt lands."
      >
        {gaps.error ? (
          <Row>
            <ErrorText error={gaps.error} />
          </Row>
        ) : !gaps.data ? (
          <BlocksLoader label="Checking every expired target…" />
        ) : !gaps.data.length ? (
          <Row>
            <CheckCircle2 className="size-5 text-ok" />
            <span>None. Every expired target has its receipt.</span>
          </Row>
        ) : (
          gaps.data.map((s) => (
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
          ))
        )}
      </Group>

      {d && <Triggers rows={d.rows} head={d.head} />}
    </div>
  );
}

// The headline numbers as a sentence: the type is the display (frontend-design: not stat tiles).
function Summary({
  rows,
  workers,
  gaps,
}: {
  rows: TriggerRow[];
  workers: WorkerStat[];
  gaps?: number;
}) {
  const covered = rows.filter((r) => !r.late.has(TRUSTED[0])).length;
  const twice = rows.filter((r) => r.late.size > 1).length;
  const [a] = workers;
  const b = (v: string | number) => (
    <span className="tnum font-semibold text-ink">{v}</span>
  );
  return (
    <p className="max-w-[34ch] text-[26px] leading-[1.32] font-medium tracking-[-0.02em] text-ink-2 sm:text-[34px]">
      {b(plural(rows.length, "trigger"))} fired in the last day. Worker A
      delivered {b(num(a.delivered))}
      {workers.length > 1 &&
        (covered ? (
          <>, and worker B covered {b(`the ${num(covered)}`)} that A missed</>
        ) : (
          <>, and worker B had nothing to cover</>
        ))}
      .{" "}
      {twice ? (
        <>{b(plural(twice, "was", "were"))} delivered twice, and </>
      ) : null}
      {gaps === undefined ? (
        "…"
      ) : (
        <>
          {b(gaps ? plural(gaps, "target") : twice ? "none" : "None")} went
          without a receipt.
        </>
      )}
    </p>
  );
}

// 24 hourly bars stacked by outcome; point at one to ring it and read its counts (bencho stacked-bars).
const HOURS = 24;
const SEGMENTS = [
  ["normal", "Delivered by A", "bg-ink-3"],
  ["covered", "Covered by B", "bg-accent"],
  ["twice", "Delivered twice", "bg-warn"],
] as const;

function Chart({
  rows,
  since,
  head,
  wall,
}: {
  rows: TriggerRow[];
  since: bigint;
  head: bigint;
  wall: number;
}) {
  const per = BigInt(BLOCKS_PER_DAY / HOURS);
  const buckets = Array.from({ length: HOURS }, () => ({
    normal: 0,
    covered: 0,
    twice: 0,
  }));
  for (const r of rows) {
    const i = Number((r.triggerBlock - since) / per);
    if (i < 0 || i >= HOURS) continue;
    const s = rowStatus(r, TRUSTED);
    buckets[i][
      s === "normal" ? "normal" : s === "delivered twice" ? "twice" : "covered"
    ]++;
  }
  const max = Math.max(
    1,
    ...buckets.map((b) => b.normal + b.covered + b.twice),
  );
  const [hover, setHover] = useState<number>();
  const at = (i: number) =>
    new Date(wall - Number(head - since - BigInt(i) * per) * BLOCK_MS);
  const hour = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  const h = hover === undefined ? undefined : buckets[hover];
  return (
    <section
      className="rounded-[22px] bg-cell p-5 sm:p-7"
      aria-label="Triggers per hour"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">Triggers per hour</h2>
          <p className="tnum mt-0.5 min-h-5 text-[13px] text-ink-2">
            {h
              ? `${hour.format(at(hover!))} to ${hour.format(at(hover! + 1))}: ${h.normal} by A, ${h.covered} covered by B${h.twice ? `, ${h.twice} twice` : ""}`
              : "Point at an hour to see what happened in it."}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
          {SEGMENTS.map(([k, label, bg]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className={cx("size-2.5 rounded-[3px]", bg)} />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div
        className="mt-6 flex h-40 items-end gap-[3px] sm:gap-1.5"
        onPointerLeave={() => setHover(undefined)}
      >
        {buckets.map((b, i) => {
          const total = b.normal + b.covered + b.twice;
          return (
            <button
              key={i}
              type="button"
              aria-label={`${hour.format(at(i))}: ${total} triggers`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              className="group relative flex h-full flex-1 cursor-default flex-col justify-end"
            >
              <span
                className={cx(
                  "flex w-full flex-col-reverse overflow-hidden rounded-[4px] transition-[opacity,box-shadow] duration-150",
                  hover !== undefined && hover !== i && "opacity-40",
                  hover === i &&
                    "shadow-[0_0_0_2px_var(--cell),0_0_0_3.5px_var(--ink)]",
                )}
                style={{
                  height: total ? `${Math.max(4, (total / max) * 100)}%` : 3,
                }}
              >
                {total === 0 ? (
                  <span className="h-full bg-fill" />
                ) : (
                  SEGMENTS.map(
                    ([k, , bg]) =>
                      b[k] > 0 && (
                        <span
                          key={k}
                          className={bg}
                          style={{ height: `${(b[k] / total) * 100}%` }}
                        />
                      ),
                  )
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="tnum mt-2 flex justify-between text-[11px] text-ink-3">
        <span>{hour.format(at(0))}</span>
        <span>{hour.format(at(12))}</span>
        <span>Now</span>
      </div>
    </section>
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

function Triggers({ rows, head }: { rows: TriggerRow[]; head: bigint }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <Group
      title={`Triggers (${num(rows.length)})`}
      right={
        rows.length > 10 && (
          <Button
            variant="plain"
            size="sm"
            className="h-auto px-0"
            onClick={() => setAll(!all)}
          >
            {all ? "Show fewer" : `Show all ${num(rows.length)}`}
          </Button>
        )
      }
    >
      {!rows.length ? (
        <Row>
          <span className="text-ink-2">No triggers in the last 24 hours.</span>
        </Row>
      ) : (
        shown.map((r) => {
          const status = rowStatus(r, TRUSTED);
          return (
            <Row key={r.triggerId} inset={60}>
              <EventGlyph event={r.event} />
              <div className="min-w-0 flex-1">
                <a
                  href={`#/s/${r.subscription}`}
                  className="font-medium hover:text-accent"
                >
                  {EVENT_TEXT[r.event]}
                </a>
                <div className="tnum flex flex-wrap items-center gap-x-1 text-[13px] text-ink-2">
                  <span>{ago(head - r.triggerBlock)},</span>
                  {[...r.late].map(([a, l], j) => (
                    <span key={a}>
                      {j > 0 && "and "}
                      {workerName(TRUSTED.indexOf(a as Hex))} {lateness(l)}
                    </span>
                  ))}
                </div>
              </div>
              <div className="hidden sm:block">
                <Hash
                  value={r.subject}
                  href={`${EXPLORER}/entity/${r.subject}`}
                />
              </div>
              {status !== "normal" && (
                <Badge tone={status === "delivered twice" ? "warn" : "accent"}>
                  {status[0].toUpperCase() + status.slice(1)}
                </Badge>
              )}
            </Row>
          );
        })
      )}
    </Group>
  );
}
