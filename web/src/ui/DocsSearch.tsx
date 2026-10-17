// ⌘K docs search (planning/PLAN/09 §3): a modal over every docs section. Opens on ⌘K / Ctrl+K, "/", or
// openSearch() from a button. Results are React text, so nothing in the docs is injected as HTML.
import { Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DOCS } from "../content.ts";
import { indexDocs, search, termsOf, type Hit } from "../docsSearch.ts";
import { askEnabled, openAsk } from "./AskPanel.tsx";
import { cx } from "./kit.tsx";

let index: ReturnType<typeof indexDocs> | undefined;
const getIndex = () => (index ??= indexDocs(DOCS)); // built on first open, not on page load

const OPEN = "prometheus:open-search";
export const openSearch = () => dispatchEvent(new Event(OPEN));

export const searchKey =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

// The router only knows #/docs/<slug>, and App scrolls to the top on every route change. So route first,
// then scroll once that page's article is on screen ([data-doc] keeps the old page's same-named id out).
function go(h: Hit) {
  const route = `#/docs/${h.slug}`;
  const same = location.hash === route;
  if (!same) location.hash = route;
  if (!h.id) return same && scrollTo({ top: 0, behavior: "smooth" });
  let frames = 30;
  const tryScroll = () => {
    const el = document.querySelector(
      `[data-doc="${h.slug}"] [id="${CSS.escape(h.id!)}"]`,
    );
    if (el) el.scrollIntoView({ behavior: same ? "smooth" : "auto" });
    else if (frames--) requestAnimationFrame(tryScroll);
  };
  requestAnimationFrame(tryScroll);
}

export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const hits = useMemo(() => (open ? search(getIndex(), q) : []), [open, q]);

  useEffect(() => {
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.(
        "input, textarea, [contenteditable]",
      );
      if (
        (e.key === "k" && (e.metaKey || e.ctrlKey)) ||
        (e.key === "/" && !typing)
      ) {
        e.preventDefault();
        setOpen((o) => !o || e.key === "/");
      }
    };
    addEventListener(OPEN, show);
    addEventListener("keydown", key);
    return () => {
      removeEventListener(OPEN, show);
      removeEventListener("keydown", key);
    };
  }, []);

  // Focus in, page scroll locked while open; focus goes back to whatever opened it.
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    input.current?.select();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      back?.focus?.();
    };
  }, [open]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current
      ?.querySelector(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // The last row hands the query to the docs assistant, for when the words aren't in any heading.
  const askRow = askEnabled && q.trim() !== "";
  const total = hits.length + (askRow ? 1 : 0);
  const pick = (i: number) => {
    if (i < hits.length) {
      setOpen(false);
      go(hits[i]!);
    } else if (askRow) {
      setOpen(false);
      openAsk(q.trim());
    }
  };

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
      className={cx(
        "fixed inset-0 z-[60] bg-black/25 px-4 pt-[12vh] backdrop-blur-[2px] transition-opacity ease-out max-sm:pt-4",
        open
          ? "opacity-100 duration-150"
          : "pointer-events-none opacity-0 duration-100",
      )}
    >
      <div
        role="dialog"
        aria-modal
        aria-label="Search the docs"
        className={cx(
          "mx-auto flex max-h-[min(560px,76vh)] w-full max-w-[620px] origin-top flex-col overflow-hidden rounded-[18px] bg-float shadow-float transition-transform ease-out",
          open ? "scale-100 duration-200" : "scale-[0.97] duration-100",
        )}
      >
        <label className="flex items-center gap-3 border-b border-sep px-4">
          <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = total;
                if (n)
                  setActive(
                    (a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
                  );
              } else if (e.key === "Enter") pick(active);
              else if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search the docs"
            aria-label="Search the docs"
            role="combobox"
            aria-expanded={total > 0}
            aria-controls="docs-search-results"
            aria-activedescendant={total ? `docs-hit-${active}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded-[6px] border border-sep px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
            Esc
          </kbd>
        </label>

        {q.trim() && !hits.length && (
          <p className="px-4 pt-6 pb-2 text-center text-[14px] text-ink-2">
            No section mentions “{q.trim()}”.
          </p>
        )}
        {!q.trim() ? (
          <p className="px-4 py-8 text-center text-[14px] text-ink-3">
            Search every section of {DOCS.length} pages.
          </p>
        ) : (
          <ul
            ref={list}
            id="docs-search-results"
            role="listbox"
            className="overflow-y-auto overscroll-contain p-2"
          >
            {hits.map((h, i) => (
              <li
                key={`${h.slug}#${h.id}`}
                id={`docs-hit-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === active}
                onPointerMove={() => setActive(i)}
                onClick={() => pick(i)}
                className={cx(
                  "cursor-pointer rounded-[12px] px-3 py-2.5",
                  i === active && "bg-fill",
                )}
              >
                <div className="font-mono text-[11px] tracking-[0.04em] text-ink-3">
                  {h.group} › {h.page}
                </div>
                <div className="mt-0.5 text-[15px] font-medium">
                  <Marked text={h.heading ?? h.page} q={q} />
                </div>
                {h.snippet && (
                  <p className="mt-1 line-clamp-2 text-[13px] leading-[1.45] text-ink-2">
                    <Marked text={h.snippet} q={q} />
                  </p>
                )}
              </li>
            ))}
            {askRow && (
              <li
                id={`docs-hit-${hits.length}`}
                data-i={hits.length}
                role="option"
                aria-selected={active === hits.length}
                onPointerMove={() => setActive(hits.length)}
                onClick={() => pick(hits.length)}
                className={cx(
                  "flex cursor-pointer items-center gap-3 rounded-[12px] px-3 py-3",
                  active === hits.length && "bg-fill",
                )}
              >
                <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 truncate text-[15px]">
                  Ask AI about “{q.trim()}”
                </span>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

// The query's terms wrapped in <mark>, as React elements (never HTML strings).
function Marked({ text, q }: { text: string; q: string }) {
  const terms = termsOf(q).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return text;
  return text.split(new RegExp(`(${terms.join("|")})`, "gi")).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-[3px] bg-accent-soft text-accent">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
