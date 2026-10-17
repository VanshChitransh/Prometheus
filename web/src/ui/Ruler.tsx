// The Lifetime ruler (UI_DESIGN.md): a block ruler that slides left one tick per block. An entity's
// remaining life is a band ending at its expiry; what the subscription does is a marker on it. Live mode
// reads one head and counts locally (a block every 2 s); demo mode plays a sped-up story per trigger.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Trigger } from "../../../shared/schema.ts";
import { BLOCK_MS, cx, duration } from "./kit.tsx";

type Tone = "ink" | "warn" | "bad" | "ok" | "accent";
type Marker = { at: number; label: string; tone: Tone; fired?: boolean };
type View = {
  now: number; // the current block, fractional
  span: number; // blocks shown
  expiry?: number; // undefined: no life band (new_match)
  born?: number; // where the band starts (the entity's past)
  ghost?: [number, number]; // a renewal's extension, drawn dashed
  markers: Marker[];
  clock?: (block: number) => string; // major tick labels; none in the demo (its time is sped up)
};

const TONE_TEXT: Record<Tone, string> = {
  ink: "text-ink",
  warn: "text-warn",
  bad: "text-bad",
  ok: "text-ok",
  accent: "text-accent",
};
const TONE_BG: Record<Tone, string> = {
  ink: "bg-ink",
  warn: "bg-warn",
  bad: "bg-bad",
  ok: "bg-ok",
  accent: "bg-accent",
};

// Major tick spacing (blocks) and minor ticks per major; clock-friendly steps from 1 min to 1 week.
const SCALES: [number, number][] = [
  [30, 6],
  [60, 4],
  [150, 5],
  [300, 5],
  [900, 3],
  [1800, 6],
  [3600, 4],
  [5400, 3],
  [10800, 6],
  [21600, 6],
  [43200, 4],
  [302400, 7],
];

const PAST = 0.14; // share of the ruler left of "now"

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// The current block as a float, advanced by requestAnimationFrame. `fps` caps re-renders: the live
// ruler moves a pixel every few seconds, the demo every frame.
function useBlockClock(
  origin: number,
  speed: number,
  fps: number,
  key: unknown = 0,
) {
  const [now, setNow] = useState(origin);
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    let last = -Infinity;
    const loop = (t: number) => {
      if (t - last >= 1000 / fps) {
        last = t;
        setNow(origin + ((t - t0) / 1000) * speed);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [origin, speed, fps, key]);
  return now;
}

function RulerView({ now, span, expiry, born, ghost, markers, clock }: View) {
  const [ref, width] = useWidth();
  const start = now - span * PAST;
  const x = (b: number) => ((b - start) / span) * width;
  const clampX = (b: number) => Math.min(width, Math.max(0, x(b)));
  const nowX = x(now);

  // Ticks: the scale whose majors land 3–7 times across, minors only when ≥ 7 px apart.
  const [major, minors] =
    SCALES.find(([m]) => span / m <= 7) ?? SCALES[SCALES.length - 1];
  const minor = major / minors;
  const showMinor = (minor / span) * width >= 7;
  const step = showMinor ? minor : major;
  const ticks: { b: number; major: boolean }[] = [];
  if (width > 0)
    for (let b = Math.ceil(start / step) * step; b <= start + span; b += step)
      ticks.push({
        b,
        major: Math.round(b / step) % (showMinor ? minors : 1) === 0,
      });

  // Labels in two rows: a label that would overlap the previous one in its row moves up a row.
  const placed = markers
    .filter((m) => m.at >= start - span * 0.02 && m.at <= start + span * 1.02)
    .sort((a, b) => a.at - b.at)
    .map((m) => ({ ...m, x: clampX(m.at), row: 0 }));
  const rowEnd = [-Infinity, -Infinity];
  for (const m of placed) {
    const w = m.label.length * 6.6 + 12;
    const left = Math.min(Math.max(0, m.x - w / 2), width - w);
    m.row = left < rowEnd[0] ? 1 : 0;
    rowEnd[m.row] = left + w;
  }

  const bandFrom = born === undefined ? start : Math.max(start, born);
  return (
    <div ref={ref} className="relative h-[124px] select-none" aria-hidden>
      {width > 0 && (
        <>
          {/* the track, the life band (dimmed where it's already past), a renewal's ghost */}
          <div className="absolute inset-x-0 top-[62px] h-2 rounded-full bg-fill" />
          {expiry !== undefined && expiry > bandFrom && (
            <>
              <div
                className="absolute top-[62px] h-2 rounded-l-full bg-accent/30"
                style={{
                  left: clampX(bandFrom),
                  width: Math.max(
                    0,
                    clampX(Math.min(now, expiry)) - clampX(bandFrom),
                  ),
                }}
              />
              {expiry > now && (
                <div
                  className="absolute top-[62px] h-2 rounded-r-full bg-accent"
                  style={{
                    left: nowX,
                    width: Math.max(0, clampX(expiry) - nowX),
                  }}
                />
              )}
            </>
          )}
          {ghost && ghost[1] > now && (
            <div
              className="absolute top-[62px] h-2 rounded-r-full border border-dashed border-accent/60"
              style={{
                left: clampX(Math.max(ghost[0], now)),
                width: Math.max(
                  0,
                  clampX(ghost[1]) - clampX(Math.max(ghost[0], now)),
                ),
              }}
            />
          )}

          {/* ticks and their clock labels */}
          {ticks.map(({ b, major }) => (
            <span
              key={b}
              className={cx(
                "absolute top-[78px] w-px",
                major ? "h-3 bg-ink-3" : "h-1.5 bg-ink-3/60",
              )}
              style={{ left: x(b) }}
            />
          ))}
          {clock &&
            ticks
              .filter(
                (t) =>
                  t.major &&
                  x(t.b) > 18 &&
                  x(t.b) < width - 18 &&
                  Math.abs(x(t.b) - nowX) > 40,
              )
              .map(({ b }) => (
                <span
                  key={`l${b}`}
                  className="tnum absolute top-[96px] -translate-x-1/2 text-[11px] text-ink-3"
                  style={{ left: x(b) }}
                >
                  {clock(b)}
                </span>
              ))}

          {/* now: its label sits in the clock row, below the markers' labels */}
          <span
            className="absolute top-[50px] h-[42px] w-px bg-ink"
            style={{ left: nowX }}
          />
          <span
            className="absolute top-[96px] -translate-x-1/2 text-[11px] font-semibold text-ink"
            style={{ left: nowX }}
          >
            Now
          </span>

          {/* markers: a dot on the band, a stem, a label above */}
          {placed.map((m) => {
            const top = m.row ? 0 : 20;
            return (
              <div
                key={m.label + m.at}
                className="pointer-events-none absolute inset-y-0"
                style={{ left: m.x }}
              >
                <span
                  className={cx("absolute w-px opacity-50", TONE_BG[m.tone])}
                  style={{ top: top + 16, height: 62 - top - 16 }}
                />
                <span
                  className={cx(
                    "absolute top-[59px] size-3.5 -translate-x-1/2 rounded-full border-2 border-cell transition-transform duration-300 ease-out",
                    TONE_BG[m.tone],
                    m.fired ? "scale-125" : "scale-100",
                  )}
                  style={{ marginLeft: 0.5 }}
                />
                <span
                  className={cx(
                    "absolute rounded-[4px] bg-cell px-1 text-[12px] font-medium whitespace-nowrap",
                    TONE_TEXT[m.tone],
                  )}
                  // Centred on the marker, pulled inward at the ruler's edges.
                  style={{
                    top,
                    transform: `translateX(${m.x < 60 ? "-10%" : m.x > width - 60 ? "-90%" : "-50%"})`,
                  }}
                >
                  {m.label}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// Clock time of a block, from one wall-clock reading at `origin`.
const clockFor = (origin: number, wallAtOrigin: number, spanBlocks: number) => {
  const withDay = spanBlocks > 43200 * 1.5;
  const f = new Intl.DateTimeFormat(
    undefined,
    withDay
      ? { weekday: "short", hour: "numeric" }
      : { hour: "numeric", minute: "2-digit" },
  );
  return (b: number) =>
    f.format(new Date(wallAtOrigin + (b - origin) * BLOCK_MS));
};

// A real entity, live. `expiresAt` null: it's gone.
export function LiveRuler({
  head,
  expiresAt,
  trigger,
  leadBlocks,
  keepBlocks,
}: {
  head: bigint;
  expiresAt: bigint | null;
  trigger?: Trigger;
  leadBlocks?: bigint;
  keepBlocks?: bigint;
}) {
  const origin = Number(head);
  const [wall] = useState(Date.now);
  const left = expiresAt === null ? 0 : Number(expiresAt) - origin;
  const lead = Number(leadBlocks ?? 0n);
  const keep = trigger === "keep" ? Number(keepBlocks ?? 0n) : 0;
  // Expiry sits at ~70% across; a renewal's ghost and the warning stay on screen.
  const span = Math.max(
    60,
    (Math.max(left, lead * 1.5) + Math.min(keep, left * 0.5)) /
      (0.86 - PAST * 0.2) +
      1,
  );
  const speed = 1000 / BLOCK_MS;
  const pxPerSec = (speed / span) * 900;
  const now = useBlockClock(origin, speed, pxPerSec > 2 ? 30 : 2);
  const expiry = expiresAt === null ? undefined : Number(expiresAt);
  const clock = clockFor(origin, wall, span);

  const markers: Marker[] = [];
  if (expiry !== undefined)
    markers.push({
      at: expiry,
      label: expiry > now ? `Expires ${clock(expiry)}` : "Expired",
      tone: expiry > now ? "ink" : "bad",
    });
  // Where the action really falls; once it's behind "now" it says it has happened (or is due).
  if (expiry !== undefined && trigger === "expiring")
    markers.push({
      at: expiry - lead,
      label:
        expiry - lead > now ? `Warning, ${duration(lead)} before` : "Warned",
      tone: "warn",
      fired: expiry - lead <= now,
    });
  if (expiry !== undefined && trigger === "keep")
    markers.push({
      at: expiry - lead,
      label: expiry - lead > now ? `Renews, +${duration(keep)}` : "Renewal due",
      tone: "ok",
    });
  if (expiry !== undefined && trigger === "expired")
    markers.push({ at: expiry + 1, label: "Alert", tone: "bad" });

  return (
    <RulerView
      now={now}
      span={span}
      expiry={expiry}
      born={origin - span}
      ghost={
        trigger === "keep" && expiry !== undefined
          ? [expiry, expiry + keep]
          : undefined
      }
      markers={markers}
      clock={clock}
    />
  );
}

// --- the demo: one short story per trigger, looping (Home) ---

const SPEED = 12; // blocks per second, 24× real time
type Story = {
  end: number;
  frame: (now: number) => Omit<View, "now" | "span" | "clock">;
};

const STORIES: Record<Trigger, Story> = {
  expiring: {
    end: 100,
    frame: (n) => ({
      expiry: 80,
      born: -60,
      markers: [
        {
          at: 52,
          label: n >= 52 ? "Warned you on Telegram" : "Warning, 1 min before",
          tone: "warn",
          fired: n >= 52,
        },
        {
          at: 80,
          label: n >= 80 ? "Expired" : "Expires",
          tone: n >= 80 ? "bad" : "ink",
          fired: n >= 80,
        },
      ],
    }),
  },
  expired: {
    end: 96,
    frame: (n) => ({
      expiry: 70,
      born: -60,
      markers: [
        {
          at: 70,
          label: n >= 70 ? "Gone: alert sent" : "Expires",
          tone: n >= 70 ? "bad" : "ink",
          fired: n >= 70,
        },
      ],
    }),
  },
  keep: {
    end: Infinity, // it never runs out: that's the point
    frame: (n) => {
      const first = 70;
      const lead = 22;
      const keep = 56;
      const renewals =
        n < first - lead ? 0 : Math.floor((n - (first - lead)) / keep) + 1;
      const expiry = first + renewals * keep;
      return {
        expiry,
        born: -60,
        ghost: [expiry, expiry + keep],
        markers: [
          { at: expiry - lead, label: "Renews here", tone: "ok" },
          { at: expiry, label: "Expires", tone: "ink" },
          ...(renewals
            ? [
                {
                  at: expiry - keep - lead,
                  label: renewals > 1 ? `Renewed ×${renewals}` : "Renewed",
                  tone: "ok" as const,
                  fired: true,
                },
              ]
            : []),
        ],
      };
    },
  },
  changed: {
    end: 92,
    frame: (n) => ({
      expiry: n >= 70 ? 70 : 140,
      born: -60,
      markers: [
        { at: 18, label: "Changed", tone: "accent" as const, fired: n >= 18 },
        {
          at: 44,
          label: "Owner changed",
          tone: "accent" as const,
          fired: n >= 44,
        },
        { at: 70, label: "Deleted", tone: "bad" as const, fired: n >= 70 },
      ].filter((m) => n >= m.at - 3),
    }),
  },
  new_match: {
    end: 96,
    frame: (n) => ({
      markers: [14, 34, 52, 74]
        .filter((at) => n >= at - 3)
        .map((at, i) => ({
          at,
          label: `New record ${i + 1}`,
          tone: "accent" as const,
          fired: n >= at,
        })),
    }),
  },
};

export const DEMO_SPEEDUP = SPEED * (BLOCK_MS / 1000);

export function DemoRuler({ trigger }: { trigger: Trigger }) {
  const story = STORIES[trigger];
  const [run, setRun] = useState(0);
  const [wall] = useState(Date.now);
  const now = useBlockClock(0, SPEED, 60, `${trigger}${run}`);
  useEffect(() => {
    if (now > story.end) setRun((r) => r + 1);
  }, [now, story.end]);
  return (
    <RulerView
      now={now}
      span={150}
      clock={clockFor(0, wall, 150)}
      {...story.frame(now)}
    />
  );
}
