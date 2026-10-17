// The shared UI kit (planning/PLAN/UI_DESIGN.md). React escapes text, so on-chain strings can't inject
// markup as long as nothing here uses dangerouslySetInnerHTML.
import NumberFlow, { NumberFlowGroup } from "@number-flow/react";
import { AlertCircle, Check, Copy, Minus, Plus } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type DependencyList,
  type MouseEvent,
  type ReactNode,
} from "react";

export const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// --- numbers and time (a block every 2 s) ---

export const BLOCK_MS = 2_000;
const NUM = new Intl.NumberFormat("en-US");
export const num = (n: number | bigint) => NUM.format(n);

// Blocks → "42 min", "3 h 5 min", "2 days". Never "TTL" (LLD §2.3).
export function duration(blocks: bigint | number) {
  const s = Math.max(0, Number(blocks) * 2);
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
export const ago = (blocks: bigint | number) =>
  Number(blocks) < 15 ? "just now" : `${duration(blocks)} ago`;

// --- layout ---

export function Spark({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 243.86 297.18" className={className} aria-hidden>
      <g
        transform="translate(-3.64,301.45) scale(0.1,-0.1)"
        fill="currentColor"
      >
        <path d="M1137 2927 c-39 -198 -141 -448 -252 -616 -27 -41 -45 -76 -39 -78 5 -2 34 -19 64 -39 328 -215 533 -568 557 -956 l6 -98 91 91 c231 232 496 385 811 470 l100 26 -60 13 c-495 102 -951 481 -1154 960 -40 96 -91 257 -91 291 0 50 -17 17 -33 -64z" />
        <path d="M920 1843 c-220 -224 -511 -393 -810 -471 l-74 -19 55 -13 c586 -138 1067 -622 1209 -1214 21 -87 30 -105 30 -59 0 47 53 246 95 358 44 116 108 240 178 344 34 50 46 76 37 79 -42 14 -200 135 -275 209 -203 204 -327 469 -354 755 -5 55 -11 101 -13 103 -2 2 -37 -31 -78 -72z" />
      </g>
    </svg>
  );
}

export function PageHead({
  title,
  sub,
  right,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-display text-[clamp(30px,10vw,38px)] leading-[1.1] font-medium tracking-[-0.02em] text-balance">
          {title}
        </h1>
        {sub && (
          <p className="mt-2 max-w-[60ch] text-[17px] leading-[1.45] text-ink-2">
            {sub}
          </p>
        )}
      </div>
      {right}
    </header>
  );
}

// An inset grouped list (iOS Settings): a title above, rows inside, a footnote below.
export function Group({
  title,
  note,
  right,
  className,
  children,
}: {
  title?: ReactNode;
  note?: ReactNode;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      {(title || right) && (
        <div className="mb-2 flex items-end justify-between gap-3 px-4">
          {title && (
            <h2 className="text-[13px] font-medium text-ink-2">{title}</h2>
          )}
          {right}
        </div>
      )}
      <div className="overflow-hidden rounded-[18px] bg-cell">{children}</div>
      {note && (
        <p className="mt-2 px-4 text-[13px] leading-[1.4] text-ink-2">{note}</p>
      )}
    </section>
  );
}

// A row with an inset hairline under it (none under the last).
export function Row({
  children,
  className,
  inset = 16,
}: {
  children: ReactNode;
  className?: string;
  inset?: number;
}) {
  return (
    <div
      style={{ ["--inset" as string]: `${inset}px` }}
      className={cx(
        "relative flex min-h-12 items-center gap-3 px-4 py-3 after:absolute after:right-0 after:bottom-0 after:left-[var(--inset)] after:h-px after:bg-sep last:after:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

// --- controls ---

const BTN = {
  primary: "bg-accent text-accent-ink hover:brightness-110",
  secondary: "bg-fill text-ink hover:bg-fill-strong",
  tinted: "bg-accent-soft text-accent hover:brightness-95",
  plain: "text-accent hover:opacity-70",
  destructive: "bg-fill text-bad hover:bg-fill-strong",
};
const SIZE = {
  sm: "h-8 rounded-full px-3.5 text-[13px]",
  md: "h-10 rounded-full px-5 text-[15px]",
  lg: "h-12 rounded-[14px] px-6 text-[17px]",
};
const press =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-[transform,background-color,opacity,filter] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BTN;
  size?: keyof typeof SIZE;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(press, SIZE[size], BTN[variant], className)}
    />
  );
}

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
  onClick,
}: {
  href: string;
  variant?: keyof typeof BTN;
  size?: keyof typeof SIZE;
  className?: string;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      onClick={onClick}
      {...(external && { target: "_blank", rel: "noreferrer" })}
      className={cx(press, SIZE[size], BTN[variant], className)}
    >
      {children}
    </a>
  );
}

// iOS segmented control; the thumb slides under the choice (bencho tab-bar). Measured, not guessed, so
// labels of any width work. A transition, not keyframes: it retargets if you tap quickly.
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number }>();
  const i = options.findIndex((o) => o.value === value);
  useLayoutEffect(() => {
    const measure = () => {
      const b = box.current?.children[i + 1] as HTMLElement | undefined;
      if (b) setThumb({ x: b.offsetLeft, w: b.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [i, options.length]);
  return (
    <div
      ref={box}
      role="radiogroup"
      aria-label={label}
      className={cx(
        "relative inline-flex rounded-[10px] bg-fill p-0.5",
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute top-0.5 bottom-0.5 left-0 rounded-[8px] bg-float shadow-[0_1px_3px_rgb(0_0_0/0.12)] transition-[transform,width] duration-[240ms] ease-out"
        style={
          thumb
            ? { transform: `translateX(${thumb.x}px)`, width: thumb.w }
            : { opacity: 0 }
        }
      />
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "relative z-10 flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[8px] px-2 text-[12px] font-medium whitespace-nowrap transition-colors duration-150 sm:px-3.5 sm:text-[13px]",
            o.value === value ? "text-ink" : "text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-[31px] w-[51px] shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-out",
        checked ? "bg-ok" : "bg-fill-strong",
      )}
    >
      <span
        className="absolute top-[2px] left-[2px] size-[27px] rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.2)] transition-transform duration-[240ms] ease-out"
        style={{ transform: `translateX(${checked ? 20 : 0}px)` }}
      />
    </button>
  );
}

// − value + : tap for one step, hold to repeat faster (bencho stepper).
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  format = String,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  label: string;
}) {
  const latest = useRef(value);
  latest.current = value;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stop = () => clearTimeout(timer.current);
  const start = (dir: 1 | -1) => {
    let delay = 380;
    const tick = () => {
      const next = Math.min(max, Math.max(min, latest.current + dir * step));
      if (next === latest.current) return;
      latest.current = next;
      onChange(next);
      delay = Math.max(50, delay * 0.8);
      timer.current = setTimeout(tick, delay);
    };
    tick();
  };
  useEffect(() => stop, []);
  const side = (dir: 1 | -1) => (
    <button
      type="button"
      aria-label={`${dir > 0 ? "More" : "Less"} ${label}`}
      disabled={dir > 0 ? value >= max : value <= min}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start(dir);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === " ") &&
        (e.preventDefault(), stop(), start(dir))
      }
      onKeyUp={stop}
      className="grid h-8 w-10 cursor-pointer place-items-center text-ink transition-transform duration-100 active:scale-90 disabled:opacity-30"
    >
      {dir > 0 ? <Plus className="size-4" /> : <Minus className="size-4" />}
    </button>
  );
  return (
    <div
      className="inline-flex items-center rounded-[10px] bg-fill"
      role="group"
      aria-label={label}
    >
      {side(-1)}
      <span
        className="tnum min-w-16 text-center text-[15px] font-medium"
        aria-live="polite"
      >
        {format(value)}
      </span>
      {side(1)}
    </div>
  );
}

// A destructive button that becomes its own confirmation (bencho confirm), instead of a dialog.
export function ConfirmButton({
  children,
  confirm,
  onConfirm,
  disabled,
}: {
  children: ReactNode;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="sm"
      variant="destructive"
      disabled={disabled}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      className={cx("min-w-20", armed && "bg-bad! text-white!")}
    >
      {armed ? confirm : children}
    </Button>
  );
}

// --- data display ---

const TONE = {
  ok: "text-ok bg-ok/12",
  warn: "text-warn bg-warn/12",
  bad: "text-bad bg-bad/12",
  accent: "text-accent bg-accent-soft",
  muted: "text-ink-2 bg-fill",
};
export type Tone = keyof typeof TONE;

export function Badge({
  tone = "muted",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({
  tone = "ok",
  live,
}: {
  tone?: "ok" | "bad" | "warn" | "muted";
  live?: boolean;
}) {
  const c = { ok: "bg-ok", bad: "bg-bad", warn: "bg-warn", muted: "bg-ink-3" }[
    tone
  ];
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-2 shrink-0 rounded-full",
        c,
        live && "animate-blink",
      )}
    />
  );
}

// The copy icon morphs into a check for a moment (bencho copy-field).
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          prompt("Copy:", text); // some webviews (Telegram's) block the clipboard
        }
      }}
      className="relative inline-grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 transition-[transform,color] duration-150 hover:text-ink active:scale-90"
    >
      <Copy
        className={cx(
          "col-start-1 row-start-1 size-3.5 transition duration-200 ease-out",
          done && "scale-50 opacity-0",
        )}
      />
      <Check
        className={cx(
          "col-start-1 row-start-1 size-3.5 text-ok transition duration-200 ease-out",
          !done && "scale-50 opacity-0",
        )}
      />
    </button>
  );
}

// A key or address: mono (it is code), shortened unless `full`, linked when `href`, always copyable.
export function Hash({
  value,
  href,
  full,
  className,
}: {
  value: string;
  href?: string;
  full?: boolean;
  className?: string;
}) {
  const text = full ? value : short(value);
  const cls = "min-w-0 font-mono text-[13px] tracking-[-0.01em] break-all";
  return (
    <span
      className={cx("inline-flex min-w-0 items-center gap-0.5", className)}
      title={value}
    >
      {href ? (
        <a
          href={href}
          {...(/^https?:/.test(href) && {
            target: "_blank",
            rel: "noreferrer",
          })}
          className={cx(
            cls,
            "text-ink-2 underline decoration-sep underline-offset-[3px] hover:text-accent",
          )}
        >
          {text}
        </a>
      ) : (
        <span className={cx(cls, "text-ink-2")}>{text}</span>
      )}
      <CopyButton text={value} label="Copy key" />
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cx(
        "animate-shimmer rounded-[10px] bg-[linear-gradient(90deg,var(--fill)_25%,var(--fill-strong)_50%,var(--fill)_75%)] bg-[length:200%_100%]",
        className,
      )}
    />
  );
}

// Errors say what happened, in the interface's voice (frontend-design: errors don't apologise).
export function ErrorText({
  error,
  className,
}: {
  error: unknown;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cx(
        "flex items-start gap-2 text-[13px] leading-[1.4] text-bad",
        className,
      )}
    >
      <AlertCircle className="mt-px size-4 shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </p>
  );
}

// For reads that take seconds: a 4×4 grid of blocks lighting in a diagonal scan (bencho dot-loader).
export function BlocksLoader({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-8 text-[13px] text-ink-2"
      role="status"
    >
      <span className="grid grid-cols-4 gap-[3px]" aria-hidden>
        {Array.from({ length: 16 }, (_, i) => (
          <span
            key={i}
            className="size-[5px] animate-blink rounded-[1.5px] bg-ink-2"
            style={{
              animationDelay: `${((i % 4) + Math.floor(i / 4)) * 90}ms`,
              animationDuration: "1.1s",
            }}
          />
        ))}
      </span>
      {label}
    </div>
  );
}

// --- hooks ---

// An async load tied to the component: a result that lands after unmount (or after deps changed) is
// dropped, so a slow query can't draw over a newer page.
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [state, set] = useState<{
    data?: T;
    error?: unknown;
    loading: boolean;
  }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && set({ data, loading: false }),
      (error) => live && set({ error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

// Milliseconds left until `expiresAt`, counted locally from one head read (no polling).
export function useRemaining(expiresAt: bigint, head: bigint) {
  const [deadline] = useState(
    () => Date.now() + Number(expiresAt - head) * BLOCK_MS,
  );
  const [left, setLeft] = useState(deadline - Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      const l = deadline - Date.now();
      setLeft(l);
      if (l <= 0) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [deadline]);
  return Math.max(0, left);
}

// "1d 4h 12m" / "42m 05s": the units that matter, digits rolling as they change (bencho price-flow,
// via NumberFlow).
export function Countdown({
  ms,
  className,
}: {
  ms: number;
  className?: string;
}) {
  const t = Math.floor(ms / 1000);
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const units: [number, string][] = d
    ? [
        [d, "d"],
        [h, "h"],
        [m, "m"],
      ]
    : h
      ? [
          [h, "h"],
          [m, "m"],
          [s, "s"],
        ]
      : [
          [m, "m"],
          [s, "s"],
        ];
  return (
    <span
      className={cx("tnum inline-flex items-baseline gap-[0.28em]", className)}
      role="timer"
      aria-label={units.map(([v, u]) => `${v}${u}`).join(" ")}
    >
      <NumberFlowGroup>
        {units.map(([v, u], i) => (
          <span key={u} className="inline-flex items-baseline">
            <NumberFlow
              value={v}
              format={{ minimumIntegerDigits: i ? 2 : 1 }}
            />
            <span className="ml-[0.06em] text-[0.5em] font-medium text-ink-2">
              {u}
            </span>
          </span>
        ))}
      </NumberFlowGroup>
    </span>
  );
}
