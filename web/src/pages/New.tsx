// #/new (T4.2, LLD §7): a subscription signed by the user's own wallet. Everything the worker would
// reject is caught here first, with the worker's own reason, before anything is signed.
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Send,
  Wallet as WalletIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { zeroAddress, type Hex } from "viem";
import {
  freeCount,
  rawGetEntity,
  type RawEntity,
} from "../../../shared/arkiv.ts";
import { encodeKey } from "../../../shared/deeplink.ts";
import { BOUNDS, PROJECT, type Trigger } from "../../../shared/schema.ts";
import {
  decodeSubscription,
  keepBlocked,
} from "../../../shared/subscription.ts";
import { useWallet } from "../App.tsx";
import { toDraft, toParams, type FormValues } from "../entityForm.ts";
import { telegramClick, tg } from "../telegram.ts";
import {
  Button,
  cx,
  duration,
  ErrorText,
  Group,
  Hash,
  LinkButton,
  num,
  PageHead,
  Row,
  short,
  Segmented,
  Stepper,
  Switch,
  useLoad,
} from "../ui/kit.tsx";
import { LiveRuler } from "../ui/Ruler.tsx";
import { Funding, noGlmToast, openWallet } from "../ui/WalletMenu.tsx";
import { SearchBuilder, type SearchChoice } from "../ui/SearchBuilder.tsx";
import { balance, reader } from "../wallet.ts";
import { TriggerGlyph } from "../ui/TriggerGlyph.tsx";
import { BOT } from "./Home.tsx";

declare const __BOT_NAME__: string; // vite.config.ts

const KEY = /^0x[0-9a-fA-F]{64}$/;

const SKIP_TEXT = {
  not_permissionless:
    "Its creator didn't allow anyone else to renew it, so every renewal will be skipped.",
  deny_listed:
    "It looks like a canary or heartbeat (or is a Prometheus entity), so every renewal will be skipped.",
};

const TRIGGERS: { id: Trigger; title: string; text: string }[] = [
  {
    id: "expiring",
    title: "Warn me before it expires",
    text: "A Telegram message while there's still time to renew it.",
  },
  {
    id: "expired",
    title: "Tell me when it has expired",
    text: "One message the moment it's gone.",
  },
  {
    id: "changed",
    title: "Tell me when it changes",
    text: "Edits, a new owner, or deletion.",
  },
  {
    id: "keep",
    title: "Keep it alive",
    text: "Prometheus renews it before it expires.",
  },
  {
    id: "new_match",
    title: "Tell me about new matching records",
    text: "Pick an example record and the attributes that matter.",
  },
];

// The worker's reasons name attributes (lead_blocks…); say them in the form's own words.
const REASONS: [RegExp, string][] = [
  [/^label is required/, "Add a label. It's how you'll recognise the alert."],
  [/^target_key/, "Paste the key of the entity to watch."],
  [
    /^lead_blocks must be/,
    "Choose between 1 minute and 1 day before it expires.",
  ],
  [
    /^keep_blocks must be greater/,
    "Add more time per renewal than you renew before expiry.",
  ],
  [/^keep_blocks must be at least/, "Each renewal must add at least 1 hour."],
  [/^keep_blocks can be at most/, "Each renewal can add at most 30 days."],
];
const human = (reason: string) =>
  REASONS.find(([re]) => re.test(reason))?.[1] ??
  `${reason[0].toUpperCase()}${reason.slice(1)}.`;

type Validation = {
  notes: string[];
  blocker: string;
  target?: RawEntity | null;
  head?: bigint;
};

export function New({
  params: [presetKey, presetTrigger],
}: {
  params: string[];
}) {
  const { wallet } = useWallet();
  const [v, setV] = useState<Omit<FormValues, "search" | "targetOwner">>({
    trigger: (presetTrigger as Trigger) || "expiring",
    targetKey: presetKey ?? "",
    leadMinutes: 10,
    keepHours: 24,
    termDays: 7,
    label: "",
    publicMonitor: false,
  });
  const [choice, setChoice] = useState<SearchChoice>({});
  const [check, setCheck] = useState<Validation>({
    notes: [],
    blocker: "Checking…", // until the first validate() lands; "" would read as accepted
  });
  const [problem, setProblem] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ entityKey: Hex; label: string }>();
  // Inside Telegram, or arriving from the home page's watch box, the web walkthrough is already chosen.
  const [web, setWeb] = useState(!!tg || !!presetKey || !!presetTrigger);
  const [step, setStep] = useState(
    presetKey && presetTrigger ? 2 : presetTrigger ? 1 : 0,
  );
  // The target read is cached per key: it's free, but not worth one per keystroke.
  const target = useRef<{ key: string; entity: RawEntity | null }>(undefined);
  const seq = useRef(0);

  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) =>
    setV((s) => ({ ...s, [k]: x }));
  const values = (): FormValues => ({ ...v, ...choice });

  // Re-validates the whole form. Returns the draft only when it may be signed.
  async function validate() {
    const mine = ++seq.current;
    const fv = values();
    const head = await reader.getBlockNumber();
    const k = fv.trigger === "new_match" ? "" : fv.targetKey.trim();
    if (KEY.test(k) && target.current?.key !== k)
      target.current = { key: k, entity: await rawGetEntity(reader, k as Hex) };
    if (mine !== seq.current) return; // a newer check is running; let it render

    const draft = toDraft(fv, wallet?.address ?? zeroAddress, head);
    const d = decodeSubscription(draft);
    const t =
      KEY.test(k) && target.current?.key === k
        ? target.current.entity
        : undefined;

    const notes: string[] = [];
    let blocker =
      fv.trigger === "new_match" && !fv.search
        ? "Paste an example record and pick at least one attribute."
        : fv.trigger !== "new_match" && !k
          ? "Paste the key of the entity to watch."
          : d.ok
            ? ""
            : human(d.reason);
    if (t === null)
      blocker ||= "No live entity has that key. It may have expired already.";
    if (t) {
      const left = t.expiresAt - head;
      const lead = draft.attributes.lead_blocks as bigint | undefined;
      if (fv.trigger === "expiring" && lead !== undefined && lead >= left)
        notes.push(
          "It expires sooner than your warning time, so the warning comes right away.",
        );
      const skip = fv.trigger === "keep" && keepBlocked(t);
      if (skip) notes.push(SKIP_TEXT[skip]);
      if (fv.trigger !== "changed" && draft.expiresAt < t.expiresAt)
        notes.push(
          `The subscription ends before the entity expires (in ${duration(left)}). Choose a longer term.`,
        );
    }
    setCheck({ notes, blocker, target: t, head });
    return blocker ? undefined : { draft, fv };
  }

  useEffect(() => {
    const t = setTimeout(() => void validate().catch(setProblem), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, choice, wallet?.address]);

  // On the sign step, an empty wallet gets the funding prompt before it can fail. Unread counts as funded.
  const signing = step === 3 && !!wallet;
  const bal = useLoad(
    async () => (signing ? balance(wallet!.address) : undefined),
    [signing, wallet?.address],
  );
  const unfunded = signing && bal.data === 0n;
  // The faucet opens in a new tab: re-read when the user comes back.
  useEffect(() => {
    if (!signing) return;
    addEventListener("focus", bal.reload);
    return () => removeEventListener("focus", bal.reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signing]);

  async function submit() {
    setBusy(true);
    setProblem(undefined);
    try {
      if (!wallet)
        throw new Error("Connect a wallet first, at the top of the page.");
      const ok = await validate();
      if (!ok) return;
      // The worker ignores a creator's subscriptions past the cap, newest first: it would never fire.
      const live = await freeCount(
        reader,
        `project = str('${PROJECT}') AND kind = str('subscription') AND $creator = addr(${wallet.address})`,
      );
      if (live >= BOUNDS.subsPerCreator)
        throw new Error(
          `This wallet already has ${live} live subscriptions, and workers serve only the oldest ${BOUNDS.subsPerCreator}. Cancel one first.`,
        );
      if ((await reader.getBalance({ address: wallet.address })) === 0n)
        return void noGlmToast();
      const { entityKey } = await wallet.client.createEntity(
        toParams(ok.draft, ok.fv.termDays),
      );
      setCreated({ entityKey, label: ok.fv.label.trim() });
    } catch (e) {
      // Some GLM, but not enough for this fee: the node or MetaMask says so in words.
      if (/insufficient funds/i.test(String((e as Error)?.message ?? e)))
        noGlmToast();
      else setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  if (created) return <Created {...created} />;

  const tr = v.trigger;
  const t = check.target;
  const key = v.targetKey.trim();
  const term = `${v.termDays} day${v.termDays > 1 ? "s" : ""}`;
  // Each step's one-line answer, shown once it's done.
  const answers = [
    TRIGGERS.find((x) => x.id === tr)!.title,
    tr === "new_match" ? "An example record" : KEY.test(key) ? short(key) : "",
    tr === "expiring"
      ? `${mins(v.leadMinutes)} before · watch ${term}`
      : tr === "keep"
        ? `${mins(v.leadMinutes)} before, +${v.keepHours} h · watch ${term}`
        : `Watch ${term}`,
  ];
  const ready = [true, tr === "new_match" ? !!choice.search : !!t, true];
  const titles = [
    "What should happen",
    tr === "new_match" ? "Records to watch for" : "What to watch",
    "Timing",
    "Name it and sign",
  ];
  const bodies = [
    <div
      role="radiogroup"
      aria-label="What should happen"
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
    >
      {TRIGGERS.map(({ id, title, text }) => {
        const on = tr === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => set("trigger", id)}
            className={cx(
              "flex cursor-pointer items-start gap-3.5 rounded-[16px] border bg-cell p-4 text-left transition-[border-color,box-shadow,transform] duration-200 ease-out active:scale-[0.985] last:sm:col-span-2",
              on
                ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]"
                : "border-sep hover:border-ink-3/40",
            )}
          >
            <span
              className={cx(
                "grid size-12 shrink-0 place-items-center rounded-[12px] transition-colors duration-200",
                on ? "bg-accent-soft text-ink" : "bg-fill text-ink-2",
              )}
            >
              <TriggerGlyph trigger={id} className="size-8" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{title}</span>
              <span className="mt-0.5 block text-[13px] leading-[1.4] text-ink-2">
                {text}
              </span>
            </span>
          </button>
        );
      })}
    </div>,
    tr === "new_match" ? (
      <Group>
        <div className="p-4">
          <SearchBuilder onChange={setChoice} />
        </div>
      </Group>
    ) : (
      <Group
        note={
          t ? (
            <span className="tnum">
              Found it. It expires at block {num(t.expiresAt)}, in{" "}
              {duration(t.expiresAt - check.head!)}.
            </span>
          ) : t === null ? (
            <span className="text-warn">{check.blocker}</span>
          ) : (
            "The key of any entity on Arkiv. You don't need to own it."
          )
        }
      >
        <div className="flex items-center gap-2 py-1.5 pr-2 pl-4">
          <input
            value={v.targetKey}
            onChange={(e) => set("targetKey", e.target.value)}
            placeholder="0x…"
            aria-label="Entity key"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[15px] tracking-[-0.01em] outline-none placeholder:text-ink-3"
          />
          <Button
            size="sm"
            onClick={async () => {
              try {
                set("targetKey", (await navigator.clipboard.readText()).trim());
              } catch {
                /* the browser said no; typing still works */
              }
            }}
          >
            <ClipboardPaste className="size-3.5" /> Paste
          </Button>
        </div>
      </Group>
    ),
    <Group>
      {(tr === "expiring" || tr === "keep") && (
        <Line
          label={
            tr === "keep"
              ? "Renew this long before it expires"
              : "Warn me this long before"
          }
        >
          <Stepper
            label="minutes"
            value={v.leadMinutes}
            min={1}
            max={1440}
            onChange={(n) => set("leadMinutes", n)}
            format={mins}
          />
        </Line>
      )}
      {tr === "keep" && (
        <Line label="Add this much each time">
          <Stepper
            label="hours"
            value={v.keepHours}
            min={1}
            max={720}
            onChange={(n) => set("keepHours", n)}
            format={(n) => `${n} h`}
          />
        </Line>
      )}
      <Line label="Keep watching for">
        <Segmented
          label="Keep watching for"
          options={[1, 7, 30].map((d) => ({
            value: d,
            label: `${d} day${d > 1 ? "s" : ""}`,
          }))}
          value={v.termDays}
          onChange={(d) => set("termDays", d)}
        />
      </Line>
    </Group>,
    <div className="space-y-4">
      <Group note="Shown in every alert, so you know which one fired.">
        <input
          maxLength={80}
          value={v.label}
          onChange={(e) => set("label", e.target.value)}
          placeholder="e.g. Acme warrant canary"
          aria-label="Label"
          className="h-12 w-full bg-transparent px-4 outline-none placeholder:text-ink-3"
        />
      </Group>
      <details className="group">
        <summary className="cursor-pointer list-none px-4 text-[13px] text-ink-2 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
          <ChevronRight className="mr-1 inline size-3.5 transition-transform duration-200 group-open:rotate-90" />
          More options
        </summary>
        <Group className="mt-2">
          <Row className="justify-between">
            <span>
              <span className="block">Public monitor</span>
              <span className="block text-[13px] text-ink-2">
                Anyone may renew this subscription, not just you.
              </span>
            </span>
            <Switch
              label="Public monitor"
              checked={v.publicMonitor}
              onChange={(x) => set("publicMonitor", x)}
            />
          </Row>
        </Group>
      </details>
      {problem !== undefined && <ErrorText error={problem} />}
      {unfunded && <Funding address={wallet.address} onFunded={bal.reload} />}
      <Button
        variant="primary"
        size="lg"
        className="w-full sm:w-auto"
        // No wallet yet: the button opens the wallet menu instead of failing.
        disabled={busy || (!!wallet && !!check.blocker)}
        onClick={wallet ? submit : openWallet}
      >
        {busy
          ? "Waiting for your signature…"
          : wallet
            ? "Sign and create"
            : "Connect a wallet to sign"}
      </Button>
      <p className="text-[13px] text-ink-3">
        The subscription is an Arkiv entity owned by your wallet. Creating it
        costs a little testnet GLM.
      </p>
    </div>,
  ];

  return (
    <div className="mx-auto max-w-[1040px]">
      <PageHead
        title="New subscription"
        sub="Watch any entity on Arkiv: hear before it expires, when it changes, or have it kept alive."
      />

      {!tg && <Ways web={web} onWeb={() => setWeb(true)} />}

      {web && (
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
          <ol>
            {titles.map((title, i) => {
              const done = i < step;
              const open = i === step;
              return (
                <li key={i} className="relative flex gap-4 pb-9 last:pb-0">
                  {i < titles.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute top-10 bottom-2 left-[15px] w-0.5 rounded-full bg-sep"
                    >
                      <span
                        className={cx(
                          "block h-full origin-top rounded-full bg-accent transition-transform duration-500 ease-out",
                          !done && "scale-y-0",
                        )}
                      />
                    </span>
                  )}
                  <span
                    className={cx(
                      "tnum grid size-8 shrink-0 place-items-center rounded-full border font-mono text-[12px] transition-colors duration-300",
                      done
                        ? "border-accent bg-accent text-accent-ink"
                        : open
                          ? "border-accent bg-cell text-accent"
                          : "border-sep bg-cell text-ink-3",
                    )}
                  >
                    {done ? (
                      <Check className="size-4" strokeWidth={2.5} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <div className="min-w-0 flex-1 pt-1">
                    {done ? (
                      <button
                        type="button"
                        onClick={() => setStep(i)}
                        className="group flex w-full cursor-pointer items-baseline gap-3 text-left"
                      >
                        {/* Phones: the answer under the title; wider: beside it. */}
                        <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
                          <span className="block text-[17px] font-semibold tracking-[-0.01em]">
                            {title}
                          </span>
                          <span className="block truncate text-[14px] text-ink-2">
                            {answers[i]}
                          </span>
                        </span>
                        <span className="text-[13px] text-accent opacity-70 transition-opacity group-hover:opacity-100">
                          Edit
                        </span>
                      </button>
                    ) : (
                      <h2
                        className={cx(
                          "text-[17px] font-semibold tracking-[-0.01em]",
                          !open && "text-ink-3",
                        )}
                      >
                        {title}
                      </h2>
                    )}
                    {open && (
                      <div className="mt-4 transition-[opacity,transform] duration-300 ease-out starting:translate-y-1 starting:opacity-0">
                        {bodies[i]}
                        {i < titles.length - 1 && (
                          <div className="mt-5 flex gap-2">
                            {i > 0 && (
                              <Button onClick={() => setStep(i - 1)}>
                                Back
                              </Button>
                            )}
                            <Button
                              variant="primary"
                              disabled={!ready[i]}
                              onClick={() => setStep(i + 1)}
                            >
                              Continue <ArrowRight className="size-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {/* The subscription in one sentence, built as you go; the ruler shows it on the entity. */}
          <aside className="lg:sticky lg:top-24 lg:self-start">
            <div className="rounded-[22px] bg-cell p-5 shadow-float">
              <div className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase">
                Your subscription
              </div>
              <p className="mt-3 text-[19px] leading-[1.4] font-medium tracking-[-0.01em] text-balance">
                <Sentence
                  trigger={tr}
                  who={
                    v.label.trim()
                      ? `"${v.label.trim()}"`
                      : tr === "new_match"
                        ? "the example"
                        : KEY.test(key)
                          ? short(key)
                          : "an entity"
                  }
                  lead={mins(v.leadMinutes)}
                  keep={`${v.keepHours} h`}
                />
                .
              </p>
              {/* Every subscription is itself an Arkiv entity with a lifetime: workers stop when it ends. */}
              <p className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-2">
                <Clock className="size-3.5" /> Watching for {term}, until{" "}
                {new Date(
                  Date.now() + v.termDays * 86_400_000,
                ).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </p>
              {t && check.head !== undefined && (
                <div className="mt-4 border-t border-sep pt-3">
                  <LiveRuler
                    key={t.key}
                    head={check.head}
                    expiresAt={t.expiresAt}
                    trigger={tr}
                    leadBlocks={BigInt(v.leadMinutes * 30)}
                    keepBlocks={BigInt(v.keepHours * 1800)}
                  />
                </div>
              )}
              <div className="mt-4 space-y-2 border-t border-sep pt-3 text-[13px] leading-[1.4]">
                {check.notes.map((n) => (
                  <p key={n} className="text-warn">
                    {n}
                  </p>
                ))}
                {check.blocker ? (
                  <p className="text-ink-2">{check.blocker}</p>
                ) : (
                  <p className="flex items-center gap-1.5 text-ok">
                    <CheckCircle2 className="size-4 shrink-0" /> Workers will
                    accept this subscription.
                  </p>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

const mins = (n: number) =>
  n < 60
    ? `${n} min`
    : `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ""}`.trim();

function Sentence({
  trigger,
  who,
  lead,
  keep,
}: {
  trigger: Trigger;
  who: string;
  lead: string;
  keep: string;
}) {
  const b = (x: string) => <b className="text-accent">{x}</b>;
  if (trigger === "expiring")
    return (
      <>
        Warn me {b(lead)} before {who} expires
      </>
    );
  if (trigger === "expired") return <>Tell me when {who} has expired</>;
  if (trigger === "changed") return <>Tell me when {who} changes</>;
  if (trigger === "keep")
    return (
      <>
        Renew {who} {b(lead)} before it expires, adding {b(keep)} each time
      </>
    );
  return <>Tell me when a new record like {who} appears</>;
}

// The two ways in. Telegram leaves for the Mini App (it makes the wallet and covers the fee); the web
// card opens the walkthrough below, and the choice then shrinks to one line so the steps start high.
function Ways({ web, onWeb }: { web: boolean; onWeb: () => void }) {
  const tme = `${BOT}?startapp=new`;
  if (web)
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[14px] bg-fill px-4 py-3 text-[14px] text-ink-2">
        <WalletIcon className="size-4 text-accent" />
        Setting it up here, with your wallet.
        <a
          href={tme}
          target="_blank"
          rel="noreferrer"
          onClick={telegramClick(tme)}
          className="inline-flex items-center gap-0.5 font-medium text-accent hover:opacity-75"
        >
          Rather use Telegram? No wallet or gas needed
          <ArrowUpRight className="size-3.5" />
        </a>
      </p>
    );
  const card =
    "flex flex-col rounded-[20px] border bg-cell p-5 text-left transition-[border-color,box-shadow,transform] duration-200 ease-out active:scale-[0.985]";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <a
        href={tme}
        target="_blank"
        rel="noreferrer"
        onClick={telegramClick(tme)}
        className={cx(card, "border-sep hover:border-ink-3/40")}
      >
        <div className="flex items-center justify-between">
          <span className="grid size-10 place-items-center rounded-full bg-[#2aabee]/12 text-[#229ed9]">
            <Send className="size-[18px]" />
          </span>
          <span className="rounded-full bg-fill px-2.5 py-1 font-mono text-[11px] tracking-[0.06em] text-ink-2 uppercase">
            Easiest
          </span>
        </div>
        <span className="mt-4 text-[17px] font-semibold">In Telegram</span>
        <span className="mt-1 text-[14px] leading-[1.45] text-ink-2">
          No wallet, no gas. The bot makes a wallet for you, covers the fee, and
          your alerts arrive in the same chat.
        </span>
        <span className="mt-auto inline-flex items-center gap-1 pt-4 text-[14px] font-medium text-accent">
          Open in Telegram <ArrowUpRight className="size-4" />
        </span>
      </a>
      <button
        type="button"
        onClick={onWeb}
        className={cx(card, "cursor-pointer border-sep hover:border-ink-3/40")}
      >
        <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
          <WalletIcon className="size-[18px]" />
        </span>
        <span className="mt-4 text-[17px] font-semibold">
          Here, with your wallet
        </span>
        <span className="mt-1 text-[14px] leading-[1.45] text-ink-2">
          Sign with MetaMask or a key kept in this browser. You own the
          subscription; it costs a little testnet GLM.
        </span>
        <span className="mt-auto inline-flex items-center gap-1 pt-4 text-[14px] font-medium text-accent">
          Continue here
          <ArrowRight className="size-4" />
        </span>
      </button>
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row className="flex-wrap justify-between gap-y-2">
      <span>{label}</span>
      {children}
    </Row>
  );
}

// The receipt of what was just signed rises into place (bencho pay-button, folded out).
function Created({ entityKey, label }: { entityKey: Hex; label: string }) {
  const tme = __BOT_NAME__
    ? `https://t.me/${__BOT_NAME__}?start=${encodeKey(entityKey)}`
    : "";
  return (
    <div className="mx-auto max-w-[520px] pt-6">
      <div className="rounded-[22px] bg-cell p-6 text-center transition-[opacity,transform] duration-500 ease-out starting:translate-y-2 starting:scale-[0.97] starting:opacity-0 sm:p-8">
        <span className="mx-auto grid size-14 place-items-center rounded-full bg-ok/12 text-ok">
          <Check className="size-7" strokeWidth={2.5} />
        </span>
        <h1 className="mt-5 text-[28px] font-semibold tracking-[-0.025em]">
          Subscription created
        </h1>
        <p className="mt-1 text-ink-2">
          {label ? `"${label}" is` : "It's"} live. Workers pick it up within a
          block.
        </p>
        <div className="mt-5 flex justify-center">
          <Hash value={entityKey} />
        </div>
        <div className="mt-7 flex flex-col gap-2">
          {tme ? (
            <LinkButton
              href={tme}
              variant="primary"
              size="lg"
              onClick={telegramClick(tme)}
            >
              <Send className="size-4" /> Get alerts in Telegram
            </LinkButton>
          ) : (
            <p className="text-[13px] text-ink-2">
              Telegram alerts aren't set up for this site.
            </p>
          )}
          <LinkButton href={`#/s/${entityKey}`} variant="secondary" size="lg">
            Open its status
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
