import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { createHttpHandler } from "./http.ts";
import type { SponsorReply } from "./sponsor.ts";

type Opts = Parameters<typeof createHttpHandler>[0];

// Mounts the handler on a throwaway port; returns its base URL and a closer.
async function serve(o: Partial<Opts> = {}) {
  const server: Server = createServer(
    createHttpHandler({
      sponsor: async () => ({ status: 200, body: { tx: "0x1" } }),
      workersAlive: async () => ["0xA"],
      ...o,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// Raw bytes, for request targets fetch() refuses to send. Resolves with the status line.
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.end(text));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("end", () => resolve(out.split("\r\n")[0]!));
    s.on("error", reject);
  });
}

const quiet = async (fn: () => Promise<void>) => {
  const log = console.error;
  console.error = () => {}; // the handled failure is logged; keep test output clean
  try {
    await fn();
  } finally {
    console.error = log;
  }
};

test("a malformed request target gets 400 and the server keeps serving", async () => {
  const s = await serve();
  try {
    await quiet(async () => {
      assert.match(
        await raw(s.port, "GET //[ HTTP/1.1\r\nHost: x\r\n\r\n"),
        / 400 /,
      );
    });
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
  } finally {
    await s.close();
  }
});

test("a throwing route gets 500 and the server keeps serving", async () => {
  const s = await serve({
    sponsor: async () => {
      throw new Error("boom");
    },
  });
  try {
    await quiet(async () => {
      const r = await fetch(`${s.url}/sponsor`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(r.status, 500);
    });
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
  } finally {
    await s.close();
  }
});

test("routes: sponsor passes the body through; 404, CORS preflight, 413, 400", async () => {
  let got: unknown;
  const s = await serve({
    sponsor: async (body): Promise<SponsorReply> => {
      got = body;
      return { status: 409, body: { error: "nope" } };
    },
  });
  try {
    const ok = await fetch(`${s.url}/sponsor`, {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(ok.status, 409);
    assert.deepEqual(await ok.json(), { error: "nope" });
    assert.deepEqual(got, { a: 1 });
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");

    assert.equal((await fetch(`${s.url}/nope`)).status, 404);
    const pre = await fetch(`${s.url}/sponsor`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-methods")!, /POST/);
    const big = await fetch(`${s.url}/sponsor`, {
      method: "POST",
      body: "x".repeat(9_000),
    });
    assert.equal(big.status, 413);
    const bad = await fetch(`${s.url}/sponsor`, {
      method: "POST",
      body: "not json",
    });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});

test("/health reuses one lookup for 30 s, shared by concurrent calls", async () => {
  let t = 0;
  let lookups = 0;
  const s = await serve({
    now: () => t,
    workersAlive: async () => {
      lookups++;
      return ["0xA"];
    },
  });
  try {
    const bodies = await Promise.all(
      Array.from({ length: 5 }, async () =>
        (await fetch(`${s.url}/health`)).json(),
      ),
    );
    assert.deepEqual(bodies[0], { ok: true, workersAlive: ["0xA"] });
    assert.equal(lookups, 1);
    t = 29_999;
    await fetch(`${s.url}/health`);
    assert.equal(lookups, 1);
    t = 30_000;
    await fetch(`${s.url}/health`);
    assert.equal(lookups, 2);
  } finally {
    await s.close();
  }
});

test("/health doesn't cache a failed lookup", async () => {
  let lookups = 0;
  const s = await serve({
    workersAlive: async () => {
      if (++lookups === 1) throw new Error("node down");
      return ["0xA"];
    },
  });
  try {
    await quiet(async () => {
      const first = await (await fetch(`${s.url}/health`)).json();
      assert.deepEqual(first, { ok: true, workersAlive: null });
    });
    const second = await (await fetch(`${s.url}/health`)).json();
    assert.deepEqual(second, { ok: true, workersAlive: ["0xA"] });
    assert.equal(lookups, 2);
  } finally {
    await s.close();
  }
});

test("/ask streams SSE deltas then [DONE]; a refusal is plain JSON; off without a handler", async () => {
  let ip = "";
  const s = await serve({
    ask: (body, from) => {
      ip = from;
      if ((body as { no?: boolean }).no)
        return { status: 429, body: { error: "slow down" } };
      return {
        stream: (async function* () {
          yield "Hel";
          yield "lo";
        })(),
      };
    },
  });
  try {
    const r = await fetch(`${s.url}/ask`, {
      method: "POST",
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(
      r.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    assert.equal(
      await r.text(),
      'data: {"t":"Hel"}\n\ndata: {"t":"lo"}\n\ndata: [DONE]\n\n',
    );
    assert.equal(ip, "9.9.9.9");
    const no = await fetch(`${s.url}/ask`, {
      method: "POST",
      body: JSON.stringify({ no: true }),
    });
    assert.equal(no.status, 429);
    assert.deepEqual(await no.json(), { error: "slow down" });
  } finally {
    await s.close();
  }
  const off = await serve();
  try {
    const r = await fetch(`${off.url}/ask`, { method: "POST", body: "{}" });
    assert.equal(r.status, 503);
  } finally {
    await off.close();
  }
});

test("/ask: a failure mid-answer arrives as an error event", async () => {
  const s = await serve({
    ask: () => ({
      stream: (async function* () {
        yield "Hel";
        throw new Error("boom");
      })(),
    }),
  });
  await quiet(async () => {
    try {
      const r = await fetch(`${s.url}/ask`, { method: "POST", body: "{}" });
      assert.equal(
        await r.text(),
        'data: {"t":"Hel"}\n\ndata: {"error":"The assistant failed. Try again."}\n\n',
      );
    } finally {
      await s.close();
    }
  });
});
