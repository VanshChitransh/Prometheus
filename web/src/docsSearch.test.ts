import { test } from "node:test";
import assert from "node:assert/strict";
import { indexDocs, search, snippet } from "./docsSearch.ts";

const DOCS = [
  {
    slug: "receipts",
    title: "Receipts",
    section: "Concepts",
    body: "Every action writes a receipt.\n\n## Setup\n\nOne.\n\n#### Deep\n\nstays in Setup\n\n## Setup\n\nTwo [link](./x.md).\n\n### `keep` it\n\n```ts\nkeepAlive()\n```\n",
  },
  {
    slug: "triggers",
    title: "Triggers",
    section: "Concepts",
    body: "## Expiry warning\n\nWarns before a receipt is due.\n",
  },
];
const INDEX = indexDocs(DOCS);

test("sections split at h2/h3 with the ids render() gives them", () => {
  assert.deepEqual(
    INDEX.filter((s) => s.slug === "receipts").map((s) => [s.heading, s.id]),
    [
      [null, null],
      ["Setup", "setup"],
      ["Setup", "setup-1"], // the h4 between them still counts toward duplicates, as in render()
      ["keep it", "keep-it"],
    ],
  );
  assert.match(INDEX[1].text, /stays in Setup/);
  assert.equal(INDEX[2].text, "Two link."); // link text kept, URL dropped
  assert.equal(INDEX[3].text, "keepAlive()"); // code kept verbatim
});

test("title beats heading beats body; every term must match", () => {
  assert.deepEqual(
    search(INDEX, "receipt").map((h) => h.slug),
    ["receipts", "triggers"],
  );
  assert.deepEqual(
    search(INDEX, "expiry").map((h) => h.id),
    ["expiry-warning"],
  );
  assert.deepEqual(search(INDEX, "expiry setup"), []);
  assert.deepEqual(search(INDEX, "   "), []);
});

test("snippet centres on the match and marks cuts", () => {
  const text = `${"a ".repeat(60)}needle ${"b ".repeat(100)}`;
  const s = snippet(text, ["needle"]);
  assert.ok(s.startsWith("…") && s.endsWith("…") && s.includes("needle"));
  assert.ok(s.length <= 142);
  assert.equal(snippet("short text", ["zzz"]), "short text");
});
