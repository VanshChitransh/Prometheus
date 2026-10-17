// Hash routes (LLD §1): a static host serves one index.html and the browser never asks it for /s/….
// Regex captures become the page's arguments.
export type Page = (el: HTMLElement, ...params: string[]) => unknown;

export function startRouter(root: HTMLElement, routes: [RegExp, Page][]) {
  const render = async () => {
    const path = location.hash.slice(1) || "/";
    // A fresh element per visit: an async page that finishes after the user navigated away writes
    // into a detached node instead of over the new page.
    const el = document.createElement("div");
    root.replaceChildren(el);
    for (const [re, page] of routes) {
      const m = re.exec(path);
      if (!m) continue;
      try {
        await page(el, ...m.slice(1));
      } catch (e) {
        el.replaceChildren(errorLine(e));
      }
      return;
    }
    el.textContent = "No page here.";
  };
  addEventListener("hashchange", render);
  render();
}

export function errorLine(e: unknown) {
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = e instanceof Error ? e.message : String(e);
  return p;
}

// A link whose text is set as text, so on-chain strings can't inject markup.
export function link(href: string, text: string) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  return a;
}

// A paragraph of text and nodes. Strings become text nodes: on-chain text can't inject markup.
export function p(...parts: (string | Node)[]) {
  const el = document.createElement("p");
  el.append(...parts);
  return el;
}

// A table from headers and rows of text or nodes (text-safe like p()).
export function table(headers: string[], rows: (string | Node)[][]) {
  const t = document.createElement("table");
  const tr = (cells: (string | Node)[], tag: "th" | "td") => {
    const r = document.createElement("tr");
    for (const c of cells) {
      const cell = document.createElement(tag);
      cell.append(c);
      r.append(cell);
    }
    return r;
  };
  t.createTHead().append(tr(headers, "th"));
  t.createTBody().append(...rows.map((r) => tr(r, "td")));
  return t;
}
