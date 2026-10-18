/// <reference types="vite/client" />
// Docs: Markdown files in web/docs, bundled at build time and rendered with
// marked. The files are ours (not on-chain text), so their HTML is trusted. The same files are served
// raw for agents (vite.config.ts: /llms.txt, /llms-full.txt, /docs/<slug>.md).
import { Marked } from "marked";
import { DOCS_NAV, idOf, splitFront } from "./docsMeta.ts";

export { DOCS_NAV };

const slugOf = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");

// --- docs ---

export type Doc = {
  slug: string;
  title: string;
  description: string;
  status: "live" | "soon";
  section: string;
  body: string;
};

const docFiles = import.meta.glob("../docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sectionOf = new Map(
  DOCS_NAV.flatMap((s) => s.pages.map((p) => [p, s.title] as const)),
);

export const DOCS: Doc[] = DOCS_NAV.flatMap((s) => s.pages)
  .map((slug) => {
    const raw = Object.entries(docFiles).find(([p]) => slugOf(p) === slug)?.[1];
    if (!raw) return undefined;
    const { front, body } = splitFront(raw);
    return {
      slug,
      title: front.title || slug,
      description: front.description || "",
      status: front.status === "soon" ? "soon" : "live",
      section: sectionOf.get(slug)!,
      body,
    } satisfies Doc;
  })
  .filter((d) => d !== undefined);

export const docBySlug = (slug: string) => DOCS.find((d) => d.slug === slug);

// --- rendering ---

export type Heading = { id: string; text: string };

// Heading text for "On this page" is plain text, so undo the entities marked escaped (it&#39;s → it's).
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};
const decode = (t: string) =>
  t.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]);

// Links between docs are written as ./slug.md (they work on GitHub too); the site uses /docs/<slug>.
function route(href: string) {
  const doc =
    /^(?:\.\/|\/docs\/)?([a-z0-9-]+)\.md(?:#.*)?$/.exec(href) ??
    /^\/docs\/([a-z0-9-]+)\/?(?:#.*)?$/.exec(href);
  if (doc) return `/docs/${doc[1]}`;
  return href;
}

// The site's own address, for the `<site>` placeholder the docs use in URLs.
export const SITE =
  typeof location === "undefined" ? "<site>" : location.origin;

export function render(markdown: string) {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  const md = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        let id = idOf(html) || "section";
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 2)
          headings.push({ id, text: decode(html.replace(/<[^>]+>/g, "")) });
        return `<h${depth} id="${id}">${html}</h${depth}>`;
      },
      link({ href, title, tokens }) {
        const to = route(href);
        const external = /^https?:/.test(to);
        return `<a href="${to}"${title ? ` title="${title}"` : ""}${external ? ' target="_blank" rel="noreferrer"' : ""}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
  const html = md.parse(markdown.replaceAll("<site>", SITE), { async: false });
  return { html, headings };
}

// The docs assistant's answers. Unlike the docs, this text comes from a model, so it isn't trusted:
// raw HTML shows as text, images as their alt text, and a link only works if it goes to one of our
// routes or to http(s). Everything else marked escapes itself.
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const answerMd = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => esc(text),
    image: ({ text }) => esc(text),
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const to = route(href);
      if (!/^(#\/|https?:\/\/)/.test(to)) return inner;
      const external = to.startsWith("http");
      return `<a href="${esc(to)}"${external ? ' target="_blank" rel="noreferrer"' : ""}>${inner}</a>`;
    },
  },
});
export const renderAnswer = (markdown: string) =>
  answerMd.parse(markdown, { async: false });
