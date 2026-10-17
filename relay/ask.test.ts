import { test } from "node:test";
import assert from "node:assert/strict";
import { createAsk, loadDocs, openRouterAnswer, type Turn } from "./ask.ts";

const q = (content: string) => ({ messages: [{ role: "user", content }] });
const signal = new AbortController().signal;

function setup(o: { dailyCap?: number; perIp?: number } = {}) {
  let t = Date.parse("2026-10-18T10:00:00Z");
  const seen: Turn[][] = [];
  const ask = createAsk({
    answer: async function* (turns) {
      seen.push(turns);
      yield "ok";
    },
    dailyCap: o.dailyCap ?? 500,
    perIp: o.perIp,
    now: () => t,
  });
  return { ask, seen, advance: (ms: number) => (t += ms) };
}

const status = (r: ReturnType<ReturnType<typeof createAsk>>) =>
  "stream" in r ? 200 : r.status;

test("bad bodies get 400 with a reason, and never reach the model", () => {
  const { ask, seen } = setup();
  for (const body of [
    null,
    {},
    { messages: [] },
    { messages: [{ role: "system", content: "x" }] },
    { messages: [{ role: "user", content: 5 }] },
    { messages: [{ role: "assistant", content: "hi" }] }, // doesn't end with a question
    q("   "),
    q("x".repeat(1_001)),
  ])
    assert.equal(
      status(ask(body, "1.1.1.1", signal)),
      400,
      JSON.stringify(body),
    );
  assert.equal(seen.length, 0);
});

test("history is trimmed to the last 6 turns, starting with a question", async () => {
  const { ask, seen } = setup();
  const messages = Array.from({ length: 9 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `m${i}`,
  }));
  const r = ask({ messages }, "1.1.1.1", signal);
  assert.ok("stream" in r);
  for await (const _ of r.stream);
  // the last 6 are m3..m8; m3 is an answer, so it's dropped to start on a question
  assert.deepEqual(
    seen[0]!.map((m) => m.content),
    ["m4", "m5", "m6", "m7", "m8"],
  );
});

test("each IP gets 10 questions per 10 minutes", () => {
  const { ask, advance } = setup();
  for (let i = 0; i < 10; i++)
    assert.equal(status(ask(q("hi"), "a", signal)), 200);
  assert.equal(status(ask(q("hi"), "a", signal)), 429);
  assert.equal(status(ask(q("hi"), "b", signal)), 200); // another reader isn't blocked
  advance(10 * 60_000);
  assert.equal(status(ask(q("hi"), "a", signal)), 200);
});

test("the daily cap is shared by everyone and resets at UTC midnight", () => {
  const { ask, advance } = setup({ dailyCap: 2 });
  assert.equal(status(ask(q("hi"), "a", signal)), 200);
  assert.equal(status(ask(q("hi"), "b", signal)), 200);
  const r = ask(q("hi"), "c", signal);
  assert.equal(status(r), 429);
  assert.match((r as { body: { error: string } }).body.error, /today/);
  advance(14 * 3_600_000); // past midnight UTC
  assert.equal(status(ask(q("hi"), "c", signal)), 200);
});

test("loadDocs tags every page with its slug, in sidebar order", () => {
  const docs = loadDocs(
    new URL("../web/docs/", import.meta.url),
    "https://x.dev",
  );
  const slugs = [...docs.matchAll(/<page slug="([a-z0-9-]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(slugs[0], "introduction");
  assert.ok(slugs.length >= 10);
  assert.ok(!docs.includes("<site>")); // placeholders filled with the site URL
});

test("openRouterAnswer streams content deltas across split chunks, skipping comments", async () => {
  let sent: { models?: string[]; messages?: { role: string }[] } = {};
  const chunks = [
    ": OPENROUTER PROCESSING\n\n",
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi',
    'ces":[{"delta":{"reasoning":"hmm"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const fake = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(
      new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
          c.close();
        },
      }),
    );
  }) as typeof fetch;
  const answer = openRouterAnswer("k", "DOCS", ["a:free", "b:free"], fake);
  let out = "";
  for await (const t of answer([{ role: "user", content: "hi" }], signal))
    out += t;
  assert.equal(out, "Hello");
  assert.deepEqual(sent.models, ["a:free", "b:free"]);
  assert.deepEqual(
    sent.messages?.map((m) => m.role),
    ["system", "user"],
  );
});

test("openRouterAnswer throws OpenRouter's error, before or during the stream", async () => {
  const reply = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as typeof fetch;
  const drain = async (f: typeof fetch) => {
    for await (const _ of openRouterAnswer(
      "k",
      "D",
      ["a"],
      f,
    )([{ role: "user", content: "hi" }], signal));
  };
  await assert.rejects(drain(reply('{"error":"no"}', 429)), /OpenRouter 429/);
  await assert.rejects(
    drain(reply('data: {"error":{"message":"rate limited"}}\n\n')),
    /rate limited/,
  );
});
