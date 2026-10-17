// ⌘K search over the docs (planning/PLAN/09): every page split at its headings, matched in the browser.
// Pure: the docs come in as arguments, so Node can test it (content.ts needs Vite's import.meta.glob).
import { Marked, type Token } from "marked";
import { idOf } from "./docsMeta.ts";

export type Section = {
  slug: string;
  page: string; // the page's title
  group: string; // its sidebar section ("Concepts")
  heading: string | null; // null: the text before the page's first heading
  id: string | null; // the heading's anchor on the rendered page
  text: string;
};
export type Hit = Section & { snippet: string };

const md = new Marked({ gfm: true });

// Markdown to the words a reader sees: link text without its URL, no markup characters.
const plain = (s: string) =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*]+/g, "") // `keep`: stays "keep:"; _ is left alone, it's part of keep_blocks
    .replace(/[#>|~]+|-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tokenText = (t: Token) =>
  t.type === "code" ? (t as Token & { text: string }).text : plain(t.raw);

// Ids are made the way content.ts render() makes them, duplicates included ("setup", "setup-1"),
// which counts every heading in order. ponytail: only top-level headings; one inside a list would shift the count.
export function indexDocs(
  docs: { slug: string; title: string; section: string; body: string }[],
): Section[] {
  const out: Section[] = [];
  for (const d of docs) {
    const seen = new Map<string, number>();
    let cur: Section = {
      slug: d.slug,
      page: d.title,
      group: d.section,
      heading: null,
      id: null,
      text: "",
    };
    const flush = () => {
      cur.text = cur.text.trim();
      if (cur.heading || cur.text) out.push(cur);
    };
    for (const t of md.lexer(d.body)) {
      if (t.type !== "heading") {
        cur.text += ` ${tokenText(t)}`;
        continue;
      }
      const html = md.parseInline(t.text, { async: false });
      let id = idOf(html) || "section";
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      if (t.depth !== 2 && t.depth !== 3) continue; // h4+ text stays in its section
      flush();
      cur = { ...cur, heading: plain(t.text), id, text: "" };
    }
    flush();
  }
  return out;
}

export const termsOf = (q: string) =>
  q.toLowerCase().split(/\s+/).filter(Boolean);

// Every term must appear somewhere in the section. Title hits outrank heading hits, which outrank body
// hits; ties keep reading order. ponytail: a linear scan, fine for a few hundred sections; MiniSearch if the docs grow 10×.
export function search(index: Section[], query: string, limit = 8): Hit[] {
  const terms = termsOf(query);
  if (!terms.length) return [];
  const scored: { s: Section; score: number }[] = [];
  for (const s of index) {
    const page = s.page.toLowerCase();
    const head = (s.heading ?? "").toLowerCase();
    const text = s.text.toLowerCase();
    let score = 0;
    let own = s.heading === null; // the intro stands for the page, so a title match is enough there
    for (const t of terms) {
      const inOwn = head.includes(t) || text.includes(t);
      const w =
        (page.includes(t) ? 3 : 0) +
        (head.includes(t) ? 2 : 0) +
        (text.includes(t) ? 1 : 0);
      if (!w) {
        score = 0;
        break;
      }
      own ||= inOwn;
      score += w;
    }
    // Without `own`, a title match would list every section of that page.
    if (score && own) scored.push({ s, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ s }) => ({ ...s, snippet: snippet(s.text, terms) }));
}

// ~140 characters of the body around the first term found, cut at word boundaries.
export function snippet(text: string, terms: string[], len = 140) {
  const lower = text.toLowerCase();
  const at = Math.min(
    ...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0),
  );
  let start = Number.isFinite(at) ? Math.max(0, at - 40) : 0;
  if (start) start = text.indexOf(" ", start) + 1 || start;
  let end = Math.min(text.length, start + len);
  if (end < text.length) end = text.lastIndexOf(" ", end) || end;
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
