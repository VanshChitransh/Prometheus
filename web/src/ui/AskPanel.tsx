// The docs assistant (planning/PLAN/09 §5): a bar pinned to the bottom of every docs page and a side panel
// with the conversation. Answers stream from the relay (askClient.ts) and render through renderAnswer,
// which treats model output as untrusted. The conversation lives in this component only: nothing is saved.
import { ArrowUp, Sparkles, Square, Trash2, X } from "lucide-react";
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

export function AskPanel() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stop = useRef<AbortController>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true); // follow the answer down unless the reader scrolled up

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    const history: Turn[] = [...turns, { role: "user", content: question }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setDraft("");
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

  return (
    <>
      {/* The bar: on every docs page while the panel is closed. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return openAsk();
          openAsk(draft);
        }}
        aria-hidden={open}
        inert={open}
        className={cx(
          "fixed bottom-5 left-1/2 z-40 flex w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-center gap-2 rounded-full bg-float py-1.5 pr-1.5 pl-4 shadow-float transition-[opacity,transform] duration-200 ease-out",
          open && "pointer-events-none translate-y-3 opacity-0",
        )}
      >
        <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask the docs a question…"
          aria-label="Ask the docs a question"
          maxLength={1_000}
          className="h-9 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-3"
        />
        <button
          type="submit"
          aria-label="Ask"
          className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-ink text-page transition-transform duration-150 active:scale-[0.94]"
        >
          <ArrowUp className="size-4" />
        </button>
      </form>

      <aside
        role="dialog"
        aria-label="Ask the docs"
        aria-hidden={!open}
        inert={!open}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className={cx(
          "fixed inset-y-0 right-0 z-[55] flex w-full flex-col border-l border-sep bg-float shadow-float transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] sm:w-[440px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-sep pr-2 pl-4">
          <Sparkles className="size-4 text-accent" aria-hidden />
          <span className="text-[15px] font-medium">Ask the docs</span>
          <span className="ml-auto" />
          {turns.length > 0 && (
            <IconButton label="Clear the conversation" onClick={clear}>
              <Trash2 className="size-4" />
            </IconButton>
          )}
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
            if (a?.getAttribute("href")?.startsWith("#/") && innerWidth < 640)
              setOpen(false);
          }}
          className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-5"
        >
          {!turns.length && (
            <div className="pt-6">
              <p className="text-[15px] leading-[1.5] text-ink-2">
                Ask anything about Prometheus. Answers come only from these
                docs, with links to the pages they used.
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
                className="ml-auto w-fit max-w-[85%] rounded-[16px] bg-fill px-3.5 py-2 text-[15px] leading-[1.45] whitespace-pre-wrap"
              >
                {t.content}
              </p>
            ) : t.content ? (
              <div
                key={i}
                className="prose prose-chat"
                dangerouslySetInnerHTML={{ __html: renderAnswer(t.content) }}
              />
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
          className="shrink-0 border-t border-sep p-3"
        >
          <div className="flex items-end gap-2 rounded-[16px] border border-sep px-3 py-2 focus-within:border-ink-3">
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
              rows={1}
              maxLength={1_000}
              placeholder={
                turns.length ? "Ask a follow-up…" : "Ask a question…"
              }
              aria-label="Your question"
              className="field-sizing-content max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-ink-3"
            />
            {busy ? (
              <button
                type="button"
                aria-label="Stop the answer"
                onClick={() => stop.current?.abort()}
                className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-fill text-ink"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                disabled={!draft.trim()}
                className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-ink text-page transition-[opacity,transform] duration-150 active:scale-[0.94] disabled:cursor-default disabled:opacity-30"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
          <p className="mt-2 text-center text-[11px] text-ink-3">
            AI answers can be wrong. Check the linked page.
          </p>
        </form>
      </aside>
    </>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-9 cursor-pointer place-items-center rounded-full text-ink-2 transition-colors hover:bg-fill hover:text-ink"
    >
      {children}
    </button>
  );
}
