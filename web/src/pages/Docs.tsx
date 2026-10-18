// #/docs and #/docs/:slug: the docs, rendered from web/docs/*.md. Sidebar in reading order, the page,
// and "On this page" for its sections. Every page can be copied as Markdown (for agents).
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  FileText,
  Search,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DOCS, DOCS_NAV, docBySlug, render } from "../content.ts";
import { AskBar, askEnabled, openAsk } from "../ui/AskPanel.tsx";
import { DocsSearch, openSearch, searchKey } from "../ui/DocsSearch.tsx";
import { cx } from "../ui/kit.tsx";

const GITHUB =
  "https://github.com/VanshChitransh/Prometheus/blob/main/web/docs";

export function Docs({ params: [slug] }: { params: string[] }) {
  const doc = docBySlug(slug || "introduction") ?? DOCS[0];
  const { html, headings } = useMemo(() => render(doc?.body ?? ""), [doc]);
  if (!doc)
    return (
      <p className="text-ink-2">The docs are being written. Check back soon.</p>
    );
  const i = DOCS.indexOf(doc);
  const [prev, next] = [DOCS[i - 1], DOCS[i + 1]];

  return (
    <div className="docs-grid grid grid-cols-1 gap-10 lg:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[210px_minmax(0,1fr)_190px]">
      <Sidebar current={doc.slug} />
      <DocsSearch />

      <article className="min-w-0" data-doc={doc.slug}>
        <div className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase">
          {doc.section}
        </div>
        <h1 className="mt-3 font-display text-[clamp(30px,10vw,38px)] leading-[1.1] font-medium tracking-[-0.02em] text-balance sm:text-[44px]">
          {doc.title}
        </h1>
        {doc.description && (
          <p className="mt-3 max-w-[60ch] text-[18px] leading-[1.5] text-ink-2">
            {doc.description}
          </p>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {doc.status === "soon" && (
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">
              Coming soon
            </span>
          )}
          <CopyMarkdown
            title={doc.title}
            description={doc.description}
            body={doc.body}
          />
          <a
            href={`/docs/${doc.slug}.md`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-sep px-3 text-[13px] text-ink-2 transition-colors hover:text-ink"
          >
            <FileText className="size-3.5" /> View as Markdown
          </a>
        </div>

        <div
          className="prose mt-10"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <nav
          className="mt-16 grid grid-cols-1 gap-3 border-t border-sep pt-8 sm:grid-cols-2"
          aria-label="More docs"
        >
          {prev ? (
            <a
              href={`#/docs/${prev.slug}`}
              className="group rounded-[14px] border border-sep p-4 transition-colors hover:border-ink-3"
            >
              <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
                <ArrowLeft className="size-3.5" /> Previous
              </span>
              <span className="mt-1 block font-medium">{prev.title}</span>
            </a>
          ) : (
            <span />
          )}
          {next && (
            <a
              href={`#/docs/${next.slug}`}
              className="group rounded-[14px] border border-sep p-4 text-right transition-colors hover:border-ink-3"
            >
              <span className="flex items-center justify-end gap-1.5 text-[13px] text-ink-3">
                Next <ArrowRight className="size-3.5" />
              </span>
              <span className="mt-1 block font-medium">{next.title}</span>
            </a>
          )}
        </nav>
        <a
          href={`${GITHUB}/${doc.slug}.md`}
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-block text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          Edit this page on GitHub
        </a>
        <AskBar />
      </article>

      {headings.length > 1 && (
        <aside className="docs-toc hidden xl:block">
          <div className="sticky top-24">
            <div className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase">
              On this page
            </div>
            <ul className="mt-3 space-y-2 border-l border-sep text-[13px]">
              {headings.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() =>
                      document
                        .getElementById(h.id)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    className="-ml-px block cursor-pointer border-l border-transparent pl-3 text-left text-ink-2 transition-colors hover:border-ink hover:text-ink"
                  >
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}

function Sidebar({ current }: { current: string }) {
  const present = new Set(DOCS.map((d) => d.slug));
  const links = (
    <nav aria-label="Docs" className="space-y-7">
      {DOCS_NAV.map((s) => {
        const pages = s.pages.filter((p) => present.has(p));
        if (!pages.length) return null;
        return (
          <div key={s.title}>
            <div className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase">
              {s.title}
            </div>
            <ul className="mt-2.5 space-y-0.5">
              {pages.map((p) => (
                <li key={p}>
                  <a
                    href={`#/docs/${p}`}
                    aria-current={p === current ? "page" : undefined}
                    className={cx(
                      "-mx-2.5 block rounded-[8px] px-2.5 py-1.5 text-[14px] transition-colors",
                      p === current
                        ? "bg-fill font-medium text-ink"
                        : "text-ink-2 hover:text-ink",
                    )}
                  >
                    {docBySlug(p)!.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
  const find = (
    <button
      type="button"
      onClick={openSearch}
      className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-[12px] border border-sep px-3 text-[14px] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink-2"
    >
      <Search className="size-4" aria-hidden />
      Search docs
      <kbd className="ml-auto font-mono text-[11px] max-lg:hidden">
        {searchKey}
      </kbd>
    </button>
  );
  // Search, and beside it the assistant (when the relay offers one).
  const tools = (
    <div className="flex gap-2">
      {find}
      {askEnabled && (
        <button
          type="button"
          onClick={() => openAsk()}
          aria-label="Ask the docs assistant"
          title="Ask the docs assistant"
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-[12px] border border-sep text-accent transition-colors hover:border-ink-3"
        >
          <Sparkles className="size-4" />
        </button>
      )}
    </div>
  );
  return (
    <>
      {/* phones: the same list behind a disclosure */}
      <div className="space-y-3 lg:hidden">
        {tools}
        <details className="rounded-[14px] border border-sep px-4 py-3">
          <summary className="cursor-pointer text-[14px] font-medium">
            Docs menu
          </summary>
          <div className="mt-4">{links}</div>
        </details>
      </div>
      <aside className="hidden lg:block">
        <div className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto pr-2 pb-8">
          <div className="mb-7">{tools}</div>
          {links}
        </div>
      </aside>
    </>
  );
}

function CopyMarkdown({
  title,
  description,
  body,
}: {
  title: string;
  description: string;
  body: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        const text = `# ${title}\n\n${description}\n\n${body}`;
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          prompt("Copy the page:", text);
        }
      }}
      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-sep px-3 text-[13px] text-ink-2 transition-colors hover:text-ink"
    >
      {done ? (
        <Check className="size-3.5 text-ok" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {done ? "Copied" : "Copy page as Markdown"}
    </button>
  );
}
