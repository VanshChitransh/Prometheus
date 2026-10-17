/// <reference types="vite/client" />
// Docs and blog posts: Markdown files in web/docs and web/blog, bundled at build time and rendered with
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

// --- blog ---

export type Post = {
  slug: string;
  title: string;
  dek: string;
  date: string;
  author: string;
  body: string;
  minutes: number;
};

const postFiles = import.meta.glob("../blog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const POSTS: Post[] = Object.entries(postFiles)
  .map(([path, raw]) => {
    const { front, body } = splitFront(raw);
    return {
      slug: slugOf(path),
      title: front.title || slugOf(path),
      dek: front.dek || "",
      date: front.date || "",
      author: front.author || "The Prometheus team",
      body,
      minutes: Math.max(1, Math.round(body.split(/\s+/).length / 230)),
    };
  })
  // Newest first; same day, by slug (so a series reads in the order its slugs say).
  .sort((a, b) =>
    a.date === b.date ? a.slug.localeCompare(b.slug) : a.date < b.date ? 1 : -1,
  );

export const postBySlug = (slug: string) => POSTS.find((p) => p.slug === slug);

export const formatDate = (iso: string) =>
  iso
    ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

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

// Links between docs are written as ./slug.md (they work on GitHub too); the site uses hash routes.
function route(href: string) {
  const doc =
    /^(?:\.\/|\/docs\/)?([a-z0-9-]+)\.md(?:#.*)?$/.exec(href) ??
    /^\/docs\/([a-z0-9-]+)\/?$/.exec(href);
  if (doc) return `#/docs/${doc[1]}`;
  const post = /^\/blog\/([a-z0-9-]+)\/?$/.exec(href);
  if (post) return `#/blog/${post[1]}`;
  if (href === "/docs" || href === "/blog") return `#${href}`;
  return href;
}

// The site's own address, for the `<site>` placeholder the docs use in URLs.
export const SITE =
  typeof location === "undefined"
    ? "<site>"
    : `${location.origin}${location.pathname.replace(/\/$/, "")}`;

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
