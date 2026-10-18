// The docs assistant (planning/PLAN/09 §5). AskBar sits at the bottom of the article; clicking it opens
// AskPanel, a chat docked to the right (the page makes room on wide screens, see index.css .ask-open) or
// a full-screen sheet on phones. Answers stream from the relay (askClient.ts) and render through
// renderAnswer, which treats model output as untrusted. The conversation lives in this component only.
import {
  ArrowUp,
  Check,
  Copy,
  Maximize2,
  Minimize2,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ASK_URL, ask, type Turn } from "../askClient.ts";
import { renderAnswer } from "../content.ts";
import { cx } from "./kit.tsx";

const OPEN = "prometheus:open-ask";
// Opens the panel; with a question, asks it right away (⌘K's "Ask AI" row).
export const openAsk = (question?: string) =>
  dispatchEvent(new CustomEvent(OPEN, { detail: question }));
export const askEnabled = Boolean(ASK_URL);

const STARTERS = [
  "How do I get warned before my entity expires?",
  "What does a receipt prove?",
  "How do I keep an entity alive with the SDK?",
];

// The bar at the bottom of every docs article: sticky, so it follows the reader down the page, and in
// the article's column, so it lines up with the text. It only opens the panel; typing happens there.
export function AskBar() {
  if (!askEnabled) return null;
  return (
    <div className="ask-bar sticky bottom-5 z-30 mt-12 flex justify-center transition-[opacity,transform] duration-200 ease-out">
      <button
        type="button"
        onClick={() => openAsk()}
        className="flex h-12 w-full max-w-[560px] cursor-text items-center gap-3 rounded-full border border-sep bg-float pr-1.5 pl-4 text-left text-[15px] text-ink-3 shadow-float transition-colors hover:border-ink-3"
      >
        <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
        Ask a question…
        <span className="ml-auto grid size-9 place-items-center rounded-full bg-ink text-page">
          <ArrowUp className="size-4" aria-hidden />
        </span>
      </button>
    </div>
  );
}

export function AskPanel() {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stop = useRef<AbortController>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true); // follow the answer down unless the reader scrolled up

  // Streams an answer to the last question in `history` (which ends with a user turn).
  const run = async (history: Turn[]) => {
    if (busy) return;
    setTurns([...history, { role: "assistant", content: "" }]);
    setError("");
    setBusy(true);
    pinned.current = true;
    const ac = new AbortController();
    stop.current = ac;
    try {
      for await (const t of ask(history, ac.signal))
        setTurns((all) => {
          const last = all.at(-1)!;
          return [...all.slice(0, -1), { ...last, content: last.content + t }];
        });
    } catch (e) {
      if (!ac.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      // An answer that never started is dropped, so a retry doesn't send an empty turn.
      setTurns((all) =>
        all.at(-1)?.role === "assistant" && !all.at(-1)!.content
          ? all.slice(0, -1)
          : all,
      );
      setBusy(false);
      stop.current = null;
    }
  };
  const send = (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setDraft("");
    run([...turns, { role: "user", content: question }]);
  };
  // The last answer again: everything up to and including the last question.
  const regenerate = () => {
    const i = turns.findLastIndex((t) => t.role === "user");
    if (i >= 0) run(turns.slice(0, i + 1));
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const q = (e as CustomEvent<string | undefined>).detail;
      if (q) sendRef.current(q);
      else requestAnimationFrame(() => box.current?.focus());
    };
    addEventListener(OPEN, onOpen);
    return () => removeEventListener(OPEN, onOpen);
  }, []);

  // The page reads these classes to make room for the docked panel (index.css).
  useEffect(() => {
    const html = document.documentElement.classList;
    html.toggle("ask-open", open);
    html.toggle("ask-wide", open && wide);
    return () => html.remove("ask-open", "ask-wide");
  }, [open, wide]);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  // Leaving the docs stops a running answer, so nobody pays for text no one reads.
  useEffect(() => () => stop.current?.abort(), []);

  if (!askEnabled) return null;

  const clear = () => {
    stop.current?.abort();
    setTurns([]);
    setError("");
    box.current?.focus();
  };
  const lastAnswer = turns.findLastIndex((t) => t.role === "assistant");

  return (
    <aside
      role="dialog"
      aria-label="Docs assistant"
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      className={cx(
        "fixed inset-0 z-[55] flex flex-col bg-float transition-[transform,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        // Wide screens: an inset card the page makes room for. Phones: a full-screen sheet.
        "sm:inset-y-3 sm:right-3 sm:left-auto sm:rounded-[20px] sm:border sm:border-sep sm:shadow-float",
        wide
          ? "sm:w-[min(760px,calc(100vw-24px))]"
          : "sm:w-[min(440px,calc(100vw-24px))]",
        open ? "translate-x-0" : "translate-x-[calc(100%+24px)]",
      )}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 pr-2 pl-4">
        <Sparkles className="size-4 text-accent" aria-hidden />
        <span className="ml-1.5 text-[16px] font-medium">Assistant</span>
        <span className="ml-auto" />
        <IconButton
          label={wide ? "Narrow the panel" : "Widen the panel"}
          onClick={() => setWide((w) => !w)}
          className="max-sm:hidden"
        >
          {wide ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </IconButton>
        <IconButton
          label="Clear the conversation"
          onClick={clear}
          disabled={!turns.length}
        >
          <Trash2 className="size-4" />
        </IconButton>
        <IconButton label="Close" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </IconButton>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        // Docs links in an answer navigate in place; on a phone the panel covers the page, so it closes.
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest("a");
          if (a?.getAttribute("href")?.startsWith("/") && innerWidth < 640)
            setOpen(false);
        }}
        className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 pt-2 pb-6"
      >
        {!turns.length && (
          <div className="pt-4">
            <p className="text-[18px] font-medium">Hello 👋</p>
            <p className="mt-1.5 text-[15px] leading-[1.55] text-ink-2">
              Ask anything about Prometheus. Answers come only from these docs,
              with links to the pages they used.
            </p>
            <div className="mt-5 space-y-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="block w-full cursor-pointer rounded-[12px] border border-sep px-3.5 py-2.5 text-left text-[14px] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <p
              key={i}
              className="ml-auto w-fit max-w-[85%] rounded-[18px] bg-fill px-4 py-2.5 text-[15px] leading-[1.45] whitespace-pre-wrap"
            >
              {t.content}
            </p>
          ) : t.content ? (
            <div key={i}>
              <div
                className="prose prose-chat"
                dangerouslySetInnerHTML={{ __html: renderAnswer(t.content) }}
              />
              {/* Actions once the answer is complete: copy any answer, regenerate the last one. */}
              {!(busy && i === lastAnswer) && (
                <div className="mt-2 -ml-2 flex gap-0.5">
                  <CopyAnswer text={t.content} />
                  {i === lastAnswer && (
                    <IconButton label="Regenerate" onClick={regenerate} small>
                      <RotateCcw className="size-3.5" />
                    </IconButton>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p
              key={i}
              className="animate-pulse text-[14px] text-ink-3"
              aria-live="polite"
            >
              Reading the docs…
            </p>
          ),
        )}
        {error && (
          <p role="alert" className="text-[14px] text-bad">
            {error}
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="shrink-0 px-4 pb-4"
      >
        <div className="rounded-[18px] border border-sep px-4 pt-3 pb-2.5 transition-colors focus-within:border-accent">
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send(draft);
              }
            }}
            rows={2}
            maxLength={1_000}
            placeholder={turns.length ? "Ask a follow-up…" : "Ask a question…"}
            aria-label="Your question"
            className="field-sizing-content block max-h-40 min-h-12 w-full resize-none bg-transparent text-[15px] leading-[1.5] outline-none placeholder:text-ink-3"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[11px] text-ink-3">
              AI answers can be wrong. Check the linked page.
            </span>
            {busy ? (
              <button
                type="button"
                onClick={() => stop.current?.abort()}
                className="cursor-pointer rounded-full px-2.5 py-1 text-[13px] font-medium text-accent transition-colors hover:bg-accent-soft"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                disabled={!draft.trim()}
                className="grid size-8 cursor-pointer place-items-center rounded-full bg-ink text-page transition-[opacity,transform] duration-150 active:scale-[0.94] disabled:cursor-default disabled:opacity-25"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </form>
    </aside>
  );
}

function CopyAnswer({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : "Copy the answer"}
      small
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          prompt("Copy the answer:", text);
        }
      }}
    >
      {done ? (
        <Check className="size-3.5 text-ok" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </IconButton>
  );
}

function IconButton({
  label,
  onClick,
  children,
  small,
  disabled,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  small?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "grid cursor-pointer place-items-center rounded-full text-ink-2 transition-colors hover:bg-fill hover:text-ink disabled:pointer-events-none disabled:opacity-30",
        small ? "size-8" : "size-9",
        className,
      )}
    >
      {children}
    </button>
  );
}
