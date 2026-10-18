// /: the website's front page (planning/HOME_COPY.md). For a first-time visitor: what Arkiv lacks,
// how Prometheus fixes it, and how to start. Live numbers are free counts read from Arkiv.
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Mail,
  Package,
  Plus,
} from "lucide-react";
import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
} from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { freeCount, trustedFilter } from "../../../shared/arkiv.ts";
import { PROJECT, type Trigger } from "../../../shared/schema.ts";
import { EXPLORER, TRUSTED } from "../receipts.ts";
import { telegramClick } from "../telegram.ts";
import {
  Button,
  cx,
  ErrorText,
  LinkButton,
  num,
  Spark,
  useLoad,
} from "../ui/kit.tsx";
import { WayScene } from "../ui/WayScene.tsx";
import { reader } from "../wallet.ts";
import { liveness } from "./Coverage.tsx";

declare const __BOT_NAME__: string; // vite.config.ts
declare const __RELAY_URL__: string; // vite.config.ts; "" = no relay, so no newsletter form
export const BOT = `https://t.me/${__BOT_NAME__ || "prometheus_arkiv_bot"}`;

// The framed column every section sits in (agenttrust's hairline rails).
const Frame = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div className={cx("mx-auto max-w-[1200px] border-x border-sep", className)}>
    {children}
  </div>
);

const Eyebrow = ({
  children,
  dark,
}: {
  children: ReactNode;
  dark?: boolean;
}) => (
  <div
    className={cx(
      "font-mono text-[12px] tracking-[0.06em] uppercase",
      dark ? "text-white/45" : "text-ink-3",
    )}
  >
    / {children}
  </div>
);

const H2 = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <h2
    className={cx(
      "font-display text-[36px] leading-[1.06] text-balance sm:text-[46px]",
      className,
    )}
  >
    {children}
  </h2>
);

export function Home() {
  return (
    <div>
      <Hero />
      <Problem />
      <Fix />
      <FiveWays />
      <Trust />
      <Start />
      <Questions />
      <Subscribe />
    </div>
  );
}

// --- 1. Hero: the product itself ---

function Hero() {
  return (
    <section
      className="border-b border-sep"
      style={{ backgroundImage: "var(--hero-glow)" }}
    >
      <Frame className="grid grid-cols-1 gap-12 px-5 pt-14 pb-16 sm:px-10 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-16 lg:pb-24">
        <div>
          {/* The worker's address on the testnet explorer: every receipt Prometheus writes, live. */}
          <a
            href={TRUSTED[0] ? `${EXPLORER}/address/${TRUSTED[0]}` : EXPLORER}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2.5 rounded-full border border-ok/25 bg-ok/8 py-1.5 pr-3 pl-3 font-mono text-[12px] tracking-[0.06em] text-ink-2 uppercase transition-colors hover:border-ok/45 hover:text-ink"
          >
            {/* A steady dot with a ring pulsing out of it; reduced motion keeps just the dot. */}
            <span
              className="relative grid size-2 place-items-center"
              aria-hidden
            >
              <span className="absolute inset-0 animate-live rounded-full bg-ok motion-reduce:hidden" />
              <span className="relative size-2 rounded-full bg-ok" />
            </span>
            <span>
              <span className="text-ok">Live</span> on Arkiv's testnet
            </span>
            <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
          <h1 className="mt-6 font-display text-[46px] leading-[1.02] text-balance sm:text-[64px]">
            Know before your Arkiv data expires.
          </h1>
          <p className="mt-6 max-w-[52ch] text-[18px] leading-[1.55] text-ink-2">
            Everything stored on Arkiv has an expiry date, and nothing tells you
            when it passes. Prometheus watches the data you care about and
            messages you on Telegram before it expires. It can also keep the
            data alive for you.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton href={BOT} size="lg" onClick={telegramClick(BOT)}>
              Open in Telegram
            </LinkButton>
            <LinkButton href="/docs/sdk" size="lg" variant="plain">
              Use the SDK
            </LinkButton>
          </div>
          <Install />
        </div>
        <HeroVideo />
      </Frame>
    </section>
  );
}

// A 15 s silent loop of the web flow: paste a key, pick an alert, sign, then the Telegram warning.
// Rendered frame by frame from planning/hero-video. Reduced motion gets the still (the alert) and
// a play button instead of autoplay.
function HeroVideo() {
  const quiet = matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <figure>
      <video
        src="/hero-demo.mp4"
        poster="/hero-demo.jpg"
        width={1080}
        height={1350}
        autoPlay={!quiet}
        controls={quiet}
        muted
        loop
        playsInline
        preload={quiet ? "none" : "auto"}
        aria-label="Demo: paste an entity key, choose Warn me before it expires, connect a wallet and sign. Two workers watch every block, and Telegram sends an EXPIRING SOON alert 10 minutes before the entity expires."
        className="h-auto w-full rounded-[24px] bg-page shadow-float"
      />
      <a
        href="/new"
        className="group mt-3 inline-flex items-center gap-1.5 text-[14px] text-ink-2 transition-colors hover:text-ink"
      >
        Try it yourself
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </a>
    </figure>
  );
}

// The SDK's install line and where it lives: npm and the repo (agenttrust's install strip).
const INSTALL = "npm install prometheus-arkiv";
const NPM = "https://www.npmjs.com/package/prometheus-arkiv";
const REPO = "https://github.com/VanshChitransh/Prometheus";

function Install() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-10 max-w-[560px]">
      <div className="flex items-center gap-3 rounded-[12px] bg-band py-3 pr-2 pl-4 font-mono text-[14px] text-white/90">
        <span className="text-white/40 select-none" aria-hidden>
          $
        </span>
        <code className="min-w-0 flex-1 truncate">{INSTALL}</code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(INSTALL);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } catch {
              prompt("Copy:", INSTALL); // some webviews (Telegram's) block the clipboard
            }
          }}
          className="cursor-pointer rounded-[8px] px-2.5 py-1 text-[12px] tracking-[0.08em] text-white/55 uppercase transition-colors hover:bg-white/10 hover:text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <InstallLink
          href={NPM}
          title="npm package"
          sub="prometheus-arkiv"
          icon={<Package className="size-4.5 text-accent" />}
        />
        <InstallLink
          href={REPO}
          title="GitHub"
          sub="VanshChitransh/Prometheus"
          icon={
            <svg viewBox="0 0 16 16" className="size-4.5" aria-hidden>
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
              />
            </svg>
          }
        />
      </div>
    </div>
  );
}

function InstallLink({
  href,
  title,
  sub,
  icon,
}: {
  href: string;
  title: string;
  sub: string;
  icon: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-[14px] border border-sep bg-cell p-3 transition-colors hover:border-ink-3"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-[10px] border border-sep bg-float text-ink">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[13px] tracking-[0.06em] uppercase">
          {title}
        </span>
        <span className="block truncate font-mono text-[12.5px] text-ink-3">
          {sub}
        </span>
      </span>
    </a>
  );
}

// What arrives in Telegram, in the relay's format (relay/deliver.ts formatReceipt) minus its emoji.
const ALERTS = [
  {
    head: "EXPIRING SOON",
    label: "Acme warrant canary",
    detail: "Block 703,243.",
    time: "09:14",
  },
  {
    head: "EXPIRED",
    label: "Acme warrant canary",
    detail: "Not renewed by block 704,143.",
    time: "09:44",
  },
  {
    head: "RENEWED",
    label: "Community archive #12",
    detail: "Block 704,812.",
    time: "10:06",
  },
];

const ALERT_LINK =
  "inline-flex items-center gap-0.5 rounded-[4px] underline decoration-accent/0 underline-offset-[3px] transition-[text-decoration-color] duration-150 hover:decoration-accent/60";

function AlertPreview({ on }: { on: boolean }) {
  return (
    <figure className="relative" aria-label="Example alerts in Telegram">
      <div className="rounded-[22px] border border-sep bg-cell p-4 shadow-[0_24px_60px_-30px_rgb(10_10_10/0.25)] sm:p-5">
        <div className="flex items-center gap-3 border-b border-sep pb-4">
          <span className="grid size-9 place-items-center rounded-full bg-accent text-accent-ink">
            <Spark className="size-4" />
          </span>
          <div>
            <div className="text-[15px] font-semibold">Prometheus</div>
            <div className="text-[12px] text-ink-3">bot</div>
          </div>
        </div>
        <ol className="mt-4 space-y-3">
          {ALERTS.map((a, i) => (
            <li
              key={a.head}
              className={cx(
                "max-w-[92%] rounded-[16px] rounded-tl-[6px] bg-fill px-4 py-3 transition-[opacity,transform] duration-700 ease-out",
                !on && "translate-y-2 opacity-0",
              )}
              style={{ transitionDelay: `${i * STEP_MS + 150}ms` }}
            >
              <div className="text-[14px] font-semibold">
                {a.head} · {a.label}
              </div>
              <div className="tnum mt-0.5 text-[14px] text-ink-2">
                {a.detail}
              </div>
              <div className="mt-2 flex items-center gap-3 text-[13px] text-accent">
                {/* The alerts are examples, so the links explain the parts rather than open made-up keys. */}
                <a href="/docs/triggers" className={ALERT_LINK}>
                  Target <ArrowUpRight className="size-3.5" />
                </a>
                <a href="/docs/receipts" className={ALERT_LINK}>
                  Receipt <ArrowUpRight className="size-3.5" />
                </a>
                <span className="tnum ml-auto text-[11px] text-ink-3">
                  {a.time}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <figcaption className="mt-3 text-center font-mono text-[11px] tracking-[0.06em] text-ink-3 uppercase">
        Example alerts
      </figcaption>
    </figure>
  );
}

// --- 2. What Arkiv lacks ---

// Real entries from this buildathon (Nexora Ledger, Lapse, Door Ledger, SiteLog), checked in their repos.
const EXAMPLES = [
  [
    "Gig workers in India lose a pay record on Nexora Ledger.",
    "Nobody pressed “Keep alive” in time.",
  ],
  [
    "VPN users miss a dead warrant canary on Lapse.",
    "Unless they run a checker in cron.",
  ],
  [
    "Traders stuck behind an exchange halt hear nothing from Door Ledger.",
    "Its alerts live in the author's private monitor.",
  ],
  [
    "A construction defect on SiteLog vanishes after 90 quiet days.",
    "Someone had to press “extend”.",
  ],
];

// The last word dissolves letter by letter, then comes back.
const FadingWord = ({ word }: { word: string }) => (
  <span aria-label={word}>
    {[...word].map((c, i) => (
      <span
        key={i}
        aria-hidden
        className="inline-block"
        style={{
          animation: `letter-fade 6s ${i * 0.14}s var(--ease-in-out) infinite`,
        }}
      >
        {c}
      </span>
    ))}
  </span>
);

// A heartbeat that travels along and goes flat.
function Flatline() {
  const d =
    "M0 30 H60 L70 30 L78 8 L88 52 L96 30 H150 L160 30 L168 8 L178 52 L186 30 H240 L250 30 L258 16 L266 44 L272 30 H520";
  return (
    <div className="mt-10" aria-hidden>
      <svg
        viewBox="0 0 520 60"
        className="h-[60px] w-full max-w-[520px]"
        fill="none"
      >
        <path d={d} stroke="var(--sep)" strokeWidth="1.5" />
        <path
          d={d}
          pathLength={1}
          stroke="var(--bad)"
          strokeWidth="1.5"
          strokeDasharray="0.25 0.75"
          style={{ animation: "flatline 4s linear infinite" }}
        />
      </svg>
      <div className="mt-2 flex justify-between font-mono text-[11px] tracking-[0.06em] text-ink-3 uppercase">
        <span>Entity alive</span>
        <span className="text-bad">Expired · no event</span>
      </div>
    </div>
  );
}

function Problem() {
  return (
    <section className="border-b border-sep">
      <Frame className="grid grid-cols-1 gap-12 px-5 py-20 sm:px-10 lg:grid-cols-2 lg:gap-16 lg:py-28">
        <div>
          <Eyebrow>What Arkiv lacks</Eyebrow>
          <H2 className="mt-5">
            Arkiv data expires in <FadingWord word="silence." />
          </H2>
          <div className="mt-6 max-w-[52ch] space-y-4 text-[17px] leading-[1.6] text-ink-2">
            <p>
              Arkiv is a database where every entry, called an{" "}
              <span className="text-ink">entity</span>, is stored for a set
              time: an hour, a week, a year. When that time is up, the entity is
              gone. That's by design.
            </p>
            <p>
              But Arkiv sends no alert when it happens. If nobody checks, nobody
              finds out.
            </p>
            <p>
              In this buildathon alone,{" "}
              <span className="text-ink">6 teams</span> shipped a renew button
              someone has to remember to press, and{" "}
              <span className="text-ink">6</span> built their own watcher. Here
              is who loses out today.
            </p>
          </div>
          <Flatline />
        </div>
        <div className="flex flex-col justify-between gap-10">
          <ul className="rows-ping border-t border-sep">
            {EXAMPLES.map(([what, then]) => (
              <li key={what} className="flex gap-4 border-b border-sep py-5">
                <span className="mt-2 size-2 shrink-0 rounded-full bg-bad/70" />
                <p className="text-[17px] leading-[1.5]">
                  {what} <span className="text-ink-2">{then}</span>
                </p>
              </li>
            ))}
          </ul>
          <figure>
            <blockquote className="text-[24px] leading-[1.35] font-medium tracking-[-0.02em] sm:text-[28px]">
              "An entity that reaches its expiration date fires no event."
            </blockquote>
            <figcaption className="mt-3 text-[14px] text-ink-3">
              Arkiv documentation
            </figcaption>
            <p className="mt-6 text-[15px] text-ink-2">
              It's the most common complaint from teams building on Arkiv:{" "}
              <span className="text-ink">9 of 17</span> reported it.
            </p>
          </figure>
        </div>
      </Frame>
    </section>
  );
}

// --- 3. How Prometheus fixes it ---

const STEPS = [
  [
    "Choose what to watch.",
    "Paste the key of any entity on Arkiv, yours or someone else's, and pick what you want to know.",
  ],
  [
    "It never stops looking.",
    "Two independent workers check Arkiv at every block, every 2 seconds, day and night.",
  ],
  [
    "You hear about it.",
    "A Telegram message the moment it matters, and a public receipt on Arkiv to prove it.",
  ],
];

// The steps light in turn once the section is in view: circle, then the line down to the next, and
// each step's alert arrives with it. Step 2 then rings every 2 s, one ring per Arkiv block.
const STEP_MS = 700;

function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setSeen(true);
        io.disconnect();
      },
      { rootMargin: "0px 0px -25% 0px" },
    );
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);
  return [ref, seen] as const;
}

function Fix() {
  const [ref, on] = useSeen<HTMLElement>();
  return (
    <section ref={ref} className="border-b border-sep">
      <Frame className="grid grid-cols-1 gap-12 px-5 py-20 sm:px-10 lg:grid-cols-2 lg:gap-16 lg:py-28">
        <div>
          <Eyebrow>How Prometheus fixes it</Eyebrow>
          <H2 className="mt-5">Prometheus watches it for you.</H2>
          <ol className="mt-10">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="relative flex gap-5 pb-10 last:pb-0">
                {i < STEPS.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute top-10 bottom-2 left-[15px] w-0.5 rounded-full bg-sep"
                  >
                    <span
                      className={cx(
                        "block h-full origin-top bg-accent transition-transform duration-500 ease-out",
                        !on && "scale-y-0",
                      )}
                      style={{ transitionDelay: `${i * STEP_MS + 150}ms` }}
                    />
                  </span>
                )}
                <span
                  className={cx(
                    "tnum grid size-8 shrink-0 place-items-center rounded-full border font-mono text-[12px] transition-colors duration-300",
                    on
                      ? "border-accent bg-accent text-accent-ink"
                      : "border-sep bg-cell text-ink-3",
                    on &&
                      i === 1 &&
                      "animate-[ring_2s_var(--ease-out)_infinite]",
                  )}
                  style={{
                    transitionDelay: `${i * STEP_MS}ms`,
                    animationDelay: `${STEP_MS}ms`,
                  }}
                >
                  {i + 1}
                </span>
                <div className="pt-1">
                  <h3 className="text-[18px] font-semibold tracking-[-0.01em]">
                    {title}
                  </h3>
                  <p className="mt-1.5 text-[16px] leading-[1.55] text-ink-2">
                    {text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="lg:pt-16">
          <AlertPreview on={on} />
        </div>
      </Frame>
    </section>
  );
}

// --- 4. Five ways to watch (scrolling, or choosing one, plays its scene) ---

const WAYS: { id: Trigger; title: string; text: string }[] = [
  {
    id: "expiring",
    title: "Warn me before it expires",
    text: "A message while there's still time to renew.",
  },
  {
    id: "expired",
    title: "Tell me when it's gone",
    text: "One message when it expires.",
  },
  {
    id: "changed",
    title: "Tell me when it changes",
    text: "Edits, a new owner, or deletion.",
  },
  {
    id: "new_match",
    title: "Tell me about new matches",
    text: "A message for each new entity like the one you point at.",
  },
  {
    id: "keep",
    title: "Keep it alive",
    text: "Prometheus renews it before it expires.",
  },
];

// Wide screens: the section is tall and its inside is pinned (sticky), so scrolling walks the five
// ways. Phones: no pinning, the list is tappable buttons.
const SCROLL_PER_WAY = 70; // svh of scrolling per way

function FiveWays() {
  // pos runs 0..5: the whole part is the way on screen, the fraction is how far its scene has played.
  // Scroll sets `raw`; a spring smooths it so wheel notches (100px jumps) glide instead of step.
  const raw = useMotionValue(0);
  const smooth = useSpring(raw, {
    stiffness: 140,
    damping: 26,
    mass: 0.5,
    restDelta: 0.0005,
  });
  const [pos, setPos] = useState(0);
  useMotionValueEvent(smooth, "change", setPos);
  const ref = useRef<HTMLElement>(null);
  const play = useRef<{ stop(): void }>(null);
  useEffect(() => {
    const wide = matchMedia("(min-width: 1024px)");
    const onScroll = () => {
      if (!wide.matches) return;
      play.current?.stop();
      const r = ref.current!.getBoundingClientRect();
      const p = -r.top / (r.height - innerHeight);
      raw.set(Math.min(WAYS.length - 0.001, Math.max(0, p * WAYS.length)));
    };
    onScroll();
    smooth.jump(raw.get()); // no glide on load
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [raw, smooth]);
  // Wide screens scroll to the way (the scroll itself plays the scene). Phones have no pinned
  // scroll, so the scene plays over 3.5 s instead.
  const pick = (n: number) => {
    if (matchMedia("(min-width: 1024px)").matches) {
      const el = ref.current!;
      const top = el.getBoundingClientRect().top + scrollY;
      const run = el.offsetHeight - innerHeight;
      scrollTo({
        top: top + (run * (n + 0.9)) / WAYS.length,
        behavior: "smooth",
      });
      return;
    }
    play.current?.stop();
    raw.jump(n);
    smooth.jump(n);
    play.current = animate(raw, n + 0.95, { duration: 3.5, ease: "linear" });
  };
  const i = Math.floor(pos);
  const way = WAYS[i];
  return (
    <section
      ref={ref}
      className="border-b border-sep lg:h-(--tall)"
      style={
        {
          "--tall": `${100 + SCROLL_PER_WAY * WAYS.length}svh`,
        } as React.CSSProperties
      }
    >
      <Frame className="grid grid-cols-1 lg:sticky lg:top-15 lg:h-[calc(100svh-60px)] lg:grid-cols-[1fr_1.15fr]">
        <div className="flex flex-col justify-center border-sep px-5 pt-20 pb-10 sm:px-10 lg:border-r lg:py-10">
          <Eyebrow>What you can ask for</Eyebrow>
          <H2 className="mt-5">Five ways to watch.</H2>
          <ul
            className="mt-10"
            role="radiogroup"
            aria-label="Five ways to watch"
          >
            {WAYS.map((w, n) => {
              const on = n === i;
              return (
                <li
                  key={w.id}
                  className="relative border-b border-sep first:border-t"
                >
                  {/* How far this way's scene has played: fills as you scroll through it. */}
                  <span
                    aria-hidden
                    className="absolute -bottom-px left-0 h-px origin-left bg-accent"
                    style={{
                      width: "100%",
                      transform: `scaleX(${n < i ? 1 : on ? Math.min(1, (pos - i) / 0.85) : 0})`,
                      opacity: on ? 1 : 0,
                      transition: "opacity 200ms",
                    }}
                  />
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pick(n)}
                    className="group flex w-full cursor-pointer items-start gap-4 py-4 text-left"
                  >
                    <span
                      className={cx(
                        "tnum mt-1 w-5 shrink-0 font-mono text-[12px] transition-colors duration-200",
                        on
                          ? "text-accent"
                          : "text-ink-3 group-hover:text-ink-2",
                      )}
                    >
                      0{n + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cx(
                          "block text-[17px] font-medium transition-colors duration-200",
                          on ? "text-ink" : "text-ink-3 group-hover:text-ink-2",
                        )}
                      >
                        {w.title}
                      </span>
                      <span
                        className={cx(
                          "block pt-0.5 text-[15px] transition-colors duration-200",
                          on ? "text-ink-2" : "text-ink-3/70",
                        )}
                      >
                        {w.text}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="dot-grid relative flex flex-col justify-center overflow-hidden px-5 py-14 sm:px-10 lg:row-start-1 lg:col-start-2 max-lg:row-start-2">
          {/* Corner brackets framing the demo, as on agenttrust. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-6 sm:inset-10"
          >
            <span className="absolute top-0 left-0 size-5 border-t border-l border-ink/40" />
            <span className="absolute top-0 right-0 size-5 border-t border-r border-ink/40" />
            <span className="absolute bottom-0 left-0 size-5 border-b border-l border-ink/40" />
            <span className="absolute right-0 bottom-0 size-5 border-r border-b border-ink/40" />
            <span className="tnum absolute bottom-0 left-8 translate-y-1/3 font-mono text-[11px] text-ink-3">
              // 0{i + 1} / 0{WAYS.length}
            </span>
          </div>
          <div className="relative rounded-[20px] border border-sep bg-cell p-5 shadow-[0_24px_60px_-30px_rgb(10_10_10/0.25)] sm:p-7">
            <WayScene trigger={way.id} title={way.title} t={pos - i} />
          </div>
        </div>
      </Frame>
    </section>
  );
}

// --- 5. Why you can trust it (the dark band) ---

const count = (q: string) =>
  freeCount(reader, `project = str('${PROJECT}') AND ${q}`);

const TRUST = [
  [
    "Every action leaves a receipt.",
    "Prometheus writes what happened, when, and which worker acted, as a public entry on Arkiv. Receipts can't be rewritten; deletion is publicly logged.",
  ],
  [
    "Two workers, two servers.",
    "If one stops, the other takes over within 30 seconds.",
  ],
  [
    "Your subscription is yours.",
    "It's stored on Arkiv under your wallet, not in our database. If we disappeared, anyone could run a worker and keep serving it.",
  ],
];

function Trust() {
  const live = useLoad(
    () =>
      Promise.all([
        TRUSTED.length ? liveness() : Promise.resolve([]),
        TRUSTED.length
          ? count(`kind = str('receipt') AND ${trustedFilter(TRUSTED)}`)
          : Promise.resolve(0),
      ]),
    [],
  );
  const [workers, receipts] = live.data ?? [];
  return (
    <section className="bg-band text-white">
      <Frame className="border-band-sep px-5 py-20 sm:px-10 lg:py-28">
        <Eyebrow dark>Why you can trust it</Eyebrow>
        <H2 className="mt-5 max-w-[18ch]">
          You don't have to take our word for it.
        </H2>
        <ul className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-[18px] bg-band-sep md:grid-cols-3">
          {TRUST.map(([title, text]) => (
            <li key={title} className="bg-band-cell p-6 sm:p-8">
              <h3 className="text-[18px] font-semibold">{title}</h3>
              <p className="mt-2 text-[15px] leading-[1.6] text-white/60">
                {text}
              </p>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-6">
          <p className="tnum text-[15px] text-white/60">
            {workers ? (
              <>
                Right now:{" "}
                <span className="text-white">
                  {workers.filter(Boolean).length} of {TRUSTED.length}
                </span>{" "}
                workers live,{" "}
                <span className="text-white">{num(receipts ?? 0)}</span>{" "}
                receipts on Arkiv.
              </>
            ) : (
              "Reading the live record from Arkiv…"
            )}
          </p>
          <a
            href="/activity"
            className="inline-flex h-11 items-center gap-1.5 rounded-full bg-white px-5 text-[15px] font-medium text-[#0a0a0a] transition-transform duration-150 active:scale-[0.97]"
          >
            See the live record <ArrowUpRight className="size-4" />
          </a>
        </div>
      </Frame>
    </section>
  );
}

// --- 6. Get started ---

const PATHS = [
  {
    title: "In Telegram",
    text: "Paste a key, pick an alert, done. Telegram creates your wallet and we cover the fee.",
    cta: "Open in Telegram",
    href: BOT,
    primary: true,
  },
  {
    title: "On the web",
    text: "Connect a wallet and watch any entity. The page checks everything before you sign.",
    cta: "Watch on the web",
    href: "/new",
  },
  {
    title: "In your code",
    text: "Install the SDK and add a watch in three lines, signed by the wallet your app already has.",
    cta: "Read the SDK docs",
    href: "/docs/sdk",
  },
];

function Start() {
  return (
    <section className="border-b border-sep">
      <Frame>
        <div className="px-5 pt-20 pb-12 sm:px-10 lg:pt-28">
          <Eyebrow>Get started</Eyebrow>
          <H2 className="mt-5">Start in a minute.</H2>
        </div>
        <ul className="grid grid-cols-1 border-t border-sep md:grid-cols-3">
          {PATHS.map((p) => (
            <li
              key={p.title}
              className="flex flex-col border-sep px-5 py-10 max-md:border-b max-md:last:border-b-0 sm:px-10 md:border-r md:last:border-r-0"
            >
              <h3 className="text-[20px] font-semibold tracking-[-0.01em]">
                {p.title}
              </h3>
              <p className="mt-2 mb-6 text-[16px] leading-[1.55] text-ink-2">
                {p.text}
              </p>
              {p.href === "/docs/sdk" ? (
                <SdkSnippet />
              ) : (
                <div className="flex-1" />
              )}
              <div>
                <LinkButton
                  href={p.href}
                  variant={p.primary ? "primary" : "secondary"}
                  onClick={p.href === BOT ? telegramClick(BOT) : undefined}
                >
                  {p.cta}
                </LinkButton>
              </div>
            </li>
          ))}
        </ul>
        <p className="border-t border-sep px-5 py-6 text-[15px] text-ink-2 sm:px-10">
          Using Claude Code or Codex? Point it at{" "}
          <a
            href="/docs/for-agents"
            className="text-accent underline decoration-accent/30 underline-offset-[3px]"
          >
            our docs for agents
          </a>
          .
        </p>
      </Frame>
    </section>
  );
}

// The SDK in a few lines (sdk/README.md has the full API).
function SdkSnippet() {
  return (
    <pre className="mb-8 flex-1 overflow-x-auto rounded-[12px] bg-band p-4 font-mono text-[12.5px] leading-[1.7] text-white/85">
      <span className="text-white/45">$ </span>npm install prometheus-arkiv
      {"\n\n"}
      <span className="text-[#8fb0ff]">const</span> p ={" "}
      <span className="text-[#8fb0ff]">new</span> Prometheus(
      {"{ wallet }"});{"\n"}
      <span className="text-[#8fb0ff]">await</span> p.watch.expiring(key, {"{ "}
      before: <span className="text-[#ffc38f]">"1h"</span>, label:{" "}
      <span className="text-[#ffc38f]">"Canary"</span>
      {" });"}
    </pre>
  );
}

// --- 7. Questions (native <details>: keyboard and screen readers work for free) ---

const FAQ: [string, ReactNode][] = [
  [
    "What is Arkiv?",
    <>
      A database built for Ethereum where every entry has an expiry date. Data
      you store there is public and owned by your wallet.{" "}
      <a
        href="https://arkiv.network"
        target="_blank"
        rel="noreferrer"
        className="text-accent"
      >
        Learn more about Arkiv
      </a>
    </>,
  ],
  [
    "Do I need a wallet?",
    "Not in Telegram: one is created for you inside the app. On the web you can use MetaMask, or make a key in your browser.",
  ],
  [
    "Does it cost anything?",
    "No. Arkiv's testnet uses free test tokens, and in Telegram we send you enough to start.",
  ],
  [
    "Can I watch data I don't own?",
    "Yes. Anything on Arkiv is public, so you can watch any entity.",
  ],
  [
    "What happens if Prometheus shuts down?",
    "Your subscriptions stay on Arkiv. Anyone can run a worker from the open-source code and keep serving them.",
  ],
];

function Questions() {
  return (
    <section>
      <Frame className="grid grid-cols-1 gap-10 px-5 py-20 sm:px-10 lg:grid-cols-[1fr_1.6fr] lg:py-28">
        <div>
          <Eyebrow>Questions</Eyebrow>
          <H2 className="mt-5">Good to know.</H2>
        </div>
        <div className="border-t border-sep">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group border-b border-sep">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[17px] font-medium [&::-webkit-details-marker]:hidden">
                {q}
                <Plus className="size-5 shrink-0 text-ink-3 transition-transform duration-200 ease-out group-open:rotate-45" />
              </summary>
              <div className="max-w-[60ch] pb-6 text-[16px] leading-[1.6] text-ink-2">
                {a}
              </div>
            </details>
          ))}
        </div>
      </Frame>
    </section>
  );
}

// --- 8. Newsletter (relay POST /subscribe; the address stays in its SQLite, never on Arkiv) ---

const SUBSCRIBE_URL = __RELAY_URL__
  ? `${__RELAY_URL__.replace(/\/$/, "")}/subscribe`
  : "";

function Subscribe() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string>();
  if (!SUBSCRIBE_URL) return null;

  const send = async (e: React.FormEvent) => {
    e.preventDefault(); // the browser already checked type="email" before this runs
    setState("sending");
    setError(undefined);
    try {
      const r = await fetch(SUBSCRIBE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (r.ok) return setState("done");
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "That didn't go through. Try again.");
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
    setState("idle");
  };

  return (
    <section className="border-t border-sep">
      <Frame className="grid grid-cols-1 gap-10 px-5 py-20 sm:px-10 lg:grid-cols-[1fr_1.6fr] lg:items-end lg:py-28">
        <div>
          <Eyebrow>Newsletter</Eyebrow>
          <H2 className="mt-5 max-w-[16ch]">Subscribe to Prometheus notes.</H2>
          <p className="mt-4 max-w-[46ch] text-[17px] leading-[1.55] text-ink-2">
            New triggers, SDK releases and what we learn running workers on
            Arkiv.
          </p>
        </div>
        {state === "done" ? (
          <p className="flex items-center gap-2 text-[16px] font-medium">
            <Check className="size-5 text-ok" /> You're on the list. Thanks.
          </p>
        ) : (
          <form onSubmit={send}>
            <label
              htmlFor="newsletter-email"
              className="font-mono text-[12px] tracking-[0.06em] text-ink-3 uppercase"
            >
              Email
            </label>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <input
                id="newsletter-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-12 w-full min-w-0 rounded-full sm:flex-1 bg-page px-5 text-[16px] shadow-[inset_0_0_0_1px_var(--sep)] transition-shadow outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_2px_var(--accent)]"
              />
              <Button
                type="submit"
                size="lg"
                variant="secondary"
                disabled={state === "sending"}
                className="rounded-full font-mono text-[14px] tracking-[0.04em] uppercase"
              >
                <Mail className="size-4" />
                {state === "sending" ? "Subscribing…" : "Subscribe"}
              </Button>
            </div>
            <div className="mt-3 min-h-5 text-[13px] text-ink-2">
              {error ? (
                <ErrorText error={error} />
              ) : (
                "A short note when something ships. No spam, and we never put your email on chain."
              )}
            </div>
          </form>
        )}
      </Frame>
    </section>
  );
}
