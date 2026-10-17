// The "Five ways to watch" card: each way as a small real-life scene. Something happens to an
// entity on Arkiv (the app window), then Prometheus's Telegram alert lands like a phone banner.
// Scroll drives it: `t` (0..1) is how far the reader has scrolled through this way, so continuous
// things (countdowns, bars) follow the scroll and one-off moments (banner, 404) fire at a threshold
// and finish on their own spring. Scrolling back rewinds.
// Headlines match the relay's real format (relay/deliver.ts HEADLINE).
import { ArrowUpRight, Lock } from "lucide-react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import type { Trigger } from "../../../shared/schema.ts";
import { cx, Spark } from "./kit.tsx";

const SPRING = { type: "spring", stiffness: 420, damping: 34 } as const;
const SOFT = { type: "spring", stiffness: 220, damping: 28 } as const;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

type Alert = { head: string; detail: string } | undefined;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
// `from` -> `to` while t runs over [t0, t1].
const lerp = (from: number, to: number, t: number, t0 = 0, t1 = 1) =>
  from + (to - from) * clamp01((t - t0) / (t1 - t0));

const clock = (s: number) => {
  const t = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// --- Shared frame: the phone banner and the app window under it ---

const BannerCard = ({ alert }: { alert: NonNullable<Alert> }) => (
  <div className="flex gap-3 rounded-[18px] border border-sep bg-cell p-3 shadow-[0_10px_24px_-14px_rgb(10_10_10/0.35)]">
    <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent text-accent-ink">
      <Spark className="size-4" />
    </span>
    <div className="min-w-0 flex-1">
      <div className="flex justify-between text-[11px] text-ink-3">
        <span>Telegram · Prometheus</span>
        <span>now</span>
      </div>
      <div className="truncate text-[13px] font-semibold">{alert.head}</div>
      <div className="truncate text-[12px] text-ink-2">{alert.detail}</div>
    </div>
  </div>
);

// The banner gets its own slot above the app window: the slot opens (height 0 -> auto) and pushes
// the window down, so the alert never covers the page it's about.
function Stage({
  url,
  alert,
  children,
}: {
  url: string;
  alert: Alert;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col justify-center">
      <AnimatePresence initial={false}>
        {alert && (
          <motion.div
            key="slot"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SOFT}
            className="overflow-hidden"
          >
            {/* Padding inside the clip so the card's shadow isn't cut off. */}
            <div className="relative px-1 pt-1 pb-3">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={alert.head}
                  initial={{ y: -16, opacity: 0, scale: 0.97 }}
                  animate={{
                    y: 0,
                    opacity: 1,
                    scale: 1,
                    transition: { ...SPRING, delay: 0.08 },
                  }}
                  exit={{
                    opacity: 0,
                    scale: 0.98,
                    transition: { duration: 0.1 },
                  }}
                >
                  <BannerCard alert={alert} />
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="shrink-0 overflow-hidden rounded-[14px] border border-sep bg-cell">
        <div className="flex items-center gap-1.5 border-b border-sep bg-fill/50 px-3 py-2 font-mono text-[11px] text-ink-3">
          <Lock className="size-3" />
          {url}
          <span className="ml-auto flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-ok" /> stored on Arkiv
          </span>
        </div>
        <div className="relative h-[196px] p-4">{children}</div>
      </div>
    </div>
  );
}

const Bar = ({ value, color }: { value: number; color: string }) => (
  <div className="h-1.5 overflow-hidden rounded-full bg-fill">
    <div
      className="h-full rounded-full transition-[width,background-color] duration-300 ease-out"
      style={{
        width: `${Math.max(0, Math.min(1, value)) * 100}%`,
        background: color,
      }}
    />
  </div>
);

const Label = ({ children }: { children: ReactNode }) => (
  <div className="font-mono text-[10px] tracking-[0.06em] text-ink-3 uppercase">
    {children}
  </div>
);

// --- 1. Warn me before it expires: a booking counting down ---

function Expiring({ t }: { t: number }) {
  const left = lerp(180, 20, t, 0, 0.85);
  const low = left <= 60;
  return (
    <Stage
      url="rooms.app/booking/4821"
      alert={
        low
          ? {
              head: "🟠 EXPIRING SOON · Booking #4821",
              detail: "1 min left. Renew it to keep it.",
            }
          : undefined
      }
    >
      <Label>Booking #4821</Label>
      <div className="mt-1 text-[17px] font-semibold">Meeting room 2</div>
      <div className="text-[13px] text-ink-2">
        Fri 14:00–15:00 · booked by Alex
      </div>
      <div className="mt-5 flex items-end justify-between">
        <span className="text-[12px] text-ink-3">Expires on Arkiv in</span>
        <span
          className={cx(
            "tnum font-mono text-[26px] leading-none font-semibold transition-colors duration-300",
            low ? "text-warn" : "text-ink",
          )}
        >
          {clock(left)}
        </span>
      </div>
      <div className="mt-2">
        <Bar value={left / 180} color={low ? "var(--warn)" : "var(--accent)"} />
      </div>
    </Stage>
  );
}

// --- 2. Tell me when it's gone: a public page that turns into a 404 ---

function Expired({ t }: { t: number }) {
  const left = lerp(6, 0, t, 0, 0.5);
  const gone = t >= 0.5;
  return (
    <Stage
      url="acme.com/canary"
      alert={
        gone
          ? {
              head: "🔴 EXPIRED · Acme warrant canary",
              detail: "Not renewed by block 704,143.",
            }
          : undefined
      }
    >
      <AnimatePresence initial={false}>
        {gone ? (
          <motion.div
            key="gone"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="absolute inset-4 grid place-content-center text-center"
          >
            <div className="font-mono text-[34px] leading-none font-semibold text-ink-3">
              404
            </div>
            <div className="mt-2 text-[14px] font-semibold">
              Entity not found
            </div>
            <div className="mt-1 text-[12px] text-ink-2">
              It expired. Nobody renewed it.
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="live"
            className="absolute inset-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, filter: "blur(6px)", scale: 0.98 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <Label>Acme Inc. · Warrant canary</Label>
            <p className="mt-2 text-[15px] leading-[1.45]">
              “As of today, Acme has received no secret government orders.”
            </p>
            <div className="mt-2 text-[12px] text-ok">
              ✓ Signed by 0x6a69…E79B
            </div>
            <div className="mt-4 flex items-end justify-between">
              <span className="text-[12px] text-ink-3">
                Expires on Arkiv in
              </span>
              <span className="tnum font-mono text-[22px] leading-none font-semibold text-bad">
                {clock(left)}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Stage>
  );
}

// --- 3. Tell me when it changes: a record's owner line, as a diff ---

function Changed({ t }: { t: number }) {
  const diff = t >= 0.45;
  const row =
    "flex justify-between rounded-[6px] px-2 py-1 font-mono text-[12px]";
  return (
    <Stage
      url="landregistry.app/record/77"
      alert={
        diff
          ? {
              head: "👤 OWNER CHANGED · Land record #77",
              detail: "0x6a69…E79B → 0x77e1…04aa",
            }
          : undefined
      }
    >
      <Label>Land record #77</Label>
      <div className="mt-1 text-[17px] font-semibold">Plot 12B, North Ward</div>
      <div className="mt-3 space-y-1">
        <div className={cx(row, "text-ink-2")}>
          <span>area</span>
          <span>420 m²</span>
        </div>
        <motion.div layout transition={SOFT} className="space-y-1">
          <AnimatePresence initial={false}>
            {diff && (
              <motion.div
                key="old"
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={SOFT}
                className={cx(row, "bg-bad/8 text-bad")}
              >
                <span>- owner</span>
                <span className="line-through">0x6a69…E79B</span>
              </motion.div>
            )}
          </AnimatePresence>
          <motion.div
            layout
            transition={SOFT}
            className={cx(
              row,
              "transition-colors duration-300",
              diff ? "bg-ok/10 text-ok" : "text-ink-2",
            )}
          >
            <span>{diff ? "+ owner" : "owner"}</span>
            <span>{diff ? "0x77e1…04aa" : "0x6a69…E79B"}</span>
          </motion.div>
        </motion.div>
        <div className={cx(row, "text-ink-3")}>
          <span>updated</span>
          <span className="tnum">block {diff ? "704,388" : "704,100"}</span>
        </div>
      </div>
    </Stage>
  );
}

// --- 4. Tell me about new matches: a saved search where new rows drop in ---

const ROOMS = [
  { id: "r9", name: "Room 9", when: "Sat 09:00–10:00" },
  { id: "r5", name: "Room 5", when: "Fri 10:00–11:00" },
];
function NewMatch({ t }: { t: number }) {
  const fresh = ROOMS.slice(2 - (t >= 0.65 ? 2 : t >= 0.3 ? 1 : 0));
  const latest = fresh[0];
  return (
    <Stage
      url="rooms.app/search?like=room-2"
      alert={
        latest
          ? {
              head: `🆕 NEW MATCH · ${latest.name}`,
              detail: `${latest.when}, like the booking you watch.`,
            }
          : undefined
      }
    >
      <Label>Rooms like Room 2</Label>
      {/* A new row grows from 0 height, so it opens its own space and pushes the rows below down
          (no overlap mid-animation). The gap lives inside each row so it grows with it. */}
      <ul className="mt-2">
        <AnimatePresence initial={false}>
          {[
            ...fresh,
            { id: "r2", name: "Room 2", when: "Fri 14:00–15:00" },
          ].map((r) => (
            <motion.li
              key={r.id}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={SOFT}
              className="overflow-hidden"
            >
              <div className="pb-1.5">
                <div className="flex items-center justify-between rounded-[10px] border border-sep px-3 py-2 text-[13px]">
                  <span>
                    <span className="font-semibold">{r.name}</span>{" "}
                    <span className="text-ink-2">· {r.when}</span>
                  </span>
                  {r.id === "r2" ? (
                    <span className="text-[11px] text-ink-3">watching</span>
                  ) : (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent uppercase">
                      New
                    </span>
                  )}
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Stage>
  );
}

// --- 5. Keep it alive: the expiry date rolls forward on its own ---

function Keep({ t }: { t: number }) {
  const kept = t >= 0.55;
  const life = kept ? 1 : lerp(0.5, 0.04, t, 0, 0.5);
  const low = !kept && life < 0.25;
  return (
    <Stage
      url="archive.community/12"
      alert={
        kept
          ? {
              head: "✅ RENEWED · Community archive #12",
              detail: "Kept for 7 more days. Block 704,812.",
            }
          : undefined
      }
    >
      <Label>Community archive #12</Label>
      <div className="mt-1 text-[17px] font-semibold">1,284 public files</div>
      <div className="mt-4 flex items-center justify-between text-[13px]">
        <span className="text-ink-3">Expires on Arkiv</span>
        <span className="relative h-5 overflow-hidden font-semibold">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={kept ? "new" : "old"}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={SPRING}
              className={cx("block", kept ? "text-ok" : low && "text-bad")}
            >
              {kept ? "Oct 25, 14:00" : "Oct 18, 14:00"}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>
      <div className="mt-2">
        <Bar
          value={life}
          color={kept ? "var(--ok)" : low ? "var(--bad)" : "var(--accent)"}
        />
      </div>
      <AnimatePresence>
        {kept && (
          <motion.a
            href="#/docs/receipts"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { ...SOFT, delay: 0.25 } }}
            exit={{ opacity: 0 }}
            className="mt-4 flex items-center justify-between rounded-[10px] bg-ok/8 px-3 py-2 text-[12px] text-ok"
          >
            <span>Renewed by Prometheus · tx 0x9c4e…a1f0</span>
            <ArrowUpRight className="size-3.5" />
          </motion.a>
        )}
      </AnimatePresence>
    </Stage>
  );
}

const SCENES: Record<Trigger, (p: { t: number }) => ReactNode> = {
  expiring: Expiring,
  expired: Expired,
  changed: Changed,
  new_match: NewMatch,
  keep: Keep,
};

export function WayScene({
  trigger,
  title,
  t,
}: {
  trigger: Trigger;
  title: string;
  t: number;
}) {
  const Scene = SCENES[trigger];
  return (
    // reducedMotion="user": springs become instant fades for people who ask for less motion.
    <MotionConfig reducedMotion="user">
      {/* Old and new scene cross-fade on top of each other (no mode="wait"), so the card is never
          empty mid-swap, however fast the scroll. */}
      <div className="relative h-[370px]">
        <AnimatePresence initial={false}>
          <motion.div
            key={trigger}
            initial={{ opacity: 0, y: 8 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: { duration: 0.24, delay: 0.06, ease: EASE_OUT },
            }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            className="absolute inset-0"
          >
            <div className="flex items-center justify-between gap-4">
              <span className="text-[15px] font-semibold">{title}</span>
              <span className="font-mono text-[11px] tracking-[0.06em] whitespace-nowrap text-ink-3 uppercase">
                Example
              </span>
            </div>
            <div className="mt-4 h-[326px]">
              <Scene t={t} />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
