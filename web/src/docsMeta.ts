// What both the site (content.ts) and the build (vite.config.ts: llms.txt) need to know about the docs:
// their order, and how to read a file's frontmatter. Pure: no Vite features, so Node can import it.

// The sidebar, in reading order. A page missing from disk is skipped.
export const DOCS_NAV: { title: string; pages: string[] }[] = [
  {
    title: "Get started",
    pages: [
      "introduction",
      "quickstart-telegram",
      "quickstart-developers",
      "for-agents",
    ],
  },
  {
    title: "Concepts",
    pages: [
      "how-it-works",
      "triggers",
      "receipts",
      "workers-and-failover",
      "trust-model",
    ],
  },
  { title: "Build", pages: ["sdk", "without-the-sdk", "run-a-worker"] },
  { title: "Reference", pages: ["data-contract", "limits", "network"] },
  { title: "Project", pages: ["friction-report"] },
];

// A heading's anchor id, from its rendered inline HTML. One function, so the page (content.ts) and the
// search index (docsSearch.ts) can't disagree about where a section is.
export const idOf = (html: string) =>
  html
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// "---\nkey: value\n---\nbody". Values are single-line; a trailing "  # comment" is dropped.
export function splitFront(raw: string): {
  front: Record<string, string>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { front: {}, body: raw };
  const front: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0)
      front[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .replace(/\s+#.*$/, "")
        .trim()
        .replace(/^["']|["']$/g, "");
  }
  return { front, body: raw.slice(m[0].length) };
}
