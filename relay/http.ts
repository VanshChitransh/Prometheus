// The relay's HTTP API (LLD §6.2): GET /health, POST /sponsor, POST /ask (docs chat) and
// POST /subscribe (newsletter). Node only.
// A request handler, not a server: index.ts listens, tests mount it on a throwaway port.
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import type { AskReply } from "./ask.ts";
import type { SubscribeReply } from "./newsletter.ts";
import type { SponsorReply } from "./sponsor.ts";

const MAX_BODY = 8_192; // bytes; a /sponsor body is ~1 KB
const MAX_ASK_BODY = 65_536; // a question plus up to 5 earlier turns (ask.ts caps them)
// /health is public and each lookup spends quota (one free count per worker), so callers share one
// answer for this long: hammering the endpoint can't drain the quota delivery depends on.
const HEALTH_TTL_MS = 30_000;

// Refused past MAX_BODY before parsing, so nobody can stream junk into memory.
async function readJson(
  req: IncomingMessage,
  max = MAX_BODY,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new RangeError("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// CORS `*`: the web app calls cross-origin, and no cookies are involved. /health is public, and
// /sponsor proves who's asking with initData, not with the caller's origin.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "content-type",
};

// `ok` means the relay is up. An Arkiv outage reports workersAlive: null rather than failing the
// check: restarting the relay can't fix the node.
export function createHttpHandler(o: {
  sponsor: (body: unknown) => Promise<SponsorReply>;
  workersAlive: () => Promise<string[]>;
  ask?: (body: unknown, ip: string, signal: AbortSignal) => AskReply; // unset = /ask is off
  subscribe?: (body: unknown, ip: string) => SubscribeReply; // unset = /subscribe is off
  now?: () => number; // ms, like Date.now; tests pass a fake clock
}): RequestListener {
  const now = o.now ?? Date.now;

  // The promise is cached, not the value: concurrent calls share the one lookup in flight.
  // A failure is answered once and never cached, so the next call asks again.
  let cached: { at: number; alive: Promise<string[] | null> } | undefined;
  const workersAlive = () => {
    if (cached && now() - cached.at < HEALTH_TTL_MS) return cached.alive;
    const entry = {
      at: now(),
      alive: o.workersAlive().catch((e) => {
        console.error("[relay] /health worker check failed:", e);
        if (cached === entry) cached = undefined;
        return null;
      }),
    };
    cached = entry;
    return entry.alive;
  };

  // The server never awaits this promise, so anything thrown inside would be an unhandled
  // rejection, which kills the process: one malformed request (`GET //[`) took the whole relay
  // down (audit C1). Every request is answered from here, whatever happens.
  return async (req, res) => {
    const json = (status: number, body: unknown) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, { "content-type": "application/json", ...CORS });
      res.end(JSON.stringify(body));
    };
    try {
      await route(req, res, json, () => {
        res.writeHead(204, { ...CORS, "access-control-max-age": "86400" });
        res.end();
      });
    } catch (e) {
      console.error(`[relay] ${req.method} ${req.url} failed:`, e);
      json(500, { error: "Something went wrong. Try again." });
    }
  };

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    json: (status: number, body: unknown) => void,
    preflight: () => void,
  ) {
    if (!URL.canParse(req.url ?? "/", "http://relay"))
      return json(400, { error: "Bad request." });
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    if (req.method === "OPTIONS") return preflight();
    const body = async (max?: number) => {
      try {
        return { ok: await readJson(req, max) };
      } catch (e) {
        json(e instanceof RangeError ? 413 : 400, {
          error: e instanceof RangeError ? "Request too large." : "Send JSON.",
        });
      }
    };
    if (req.method === "POST" && path === "/sponsor") {
      const b = await body();
      if (!b) return;
      const r = await o.sponsor(b.ok); // a throw is answered 500 by the caller
      return json(r.status, r.body);
    }
    if (req.method === "POST" && path === "/ask") {
      if (!o.ask) return json(503, { error: "The docs assistant is off." });
      const b = await body(MAX_ASK_BODY);
      if (!b) return;
      // The reader closing the panel (or the tab) stops the model mid-answer, and its spend.
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      const r = o.ask(b.ok, clientIp(req), ac.signal);
      if (!("stream" in r)) return json(r.status, r.body);
      return sse(res, r.stream, ac.signal);
    }
    if (req.method === "POST" && path === "/subscribe") {
      if (!o.subscribe) return json(503, { error: "Sign-ups are off." });
      const b = await body();
      if (!b) return;
      const r = o.subscribe(b.ok, clientIp(req));
      return json(r.status, r.body);
    }
    if (req.method === "GET" && path === "/health")
      return json(200, { ok: true, workersAlive: await workersAlive() });
    json(404, { error: "not found" });
  }
}

// Behind Caddy (compose.yaml) the first X-Forwarded-For entry is the client: Caddy drops whatever an
// untrusted client sent. Run without a proxy, it can be spoofed, so a public relay needs Caddy in front.
function clientIp(req: IncomingMessage) {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

// One `data: {"t": "..."}` event per text delta, then `data: [DONE]`. A failure after the headers went
// out can't change the status, so it arrives as a `data: {"error": ...}` event instead.
async function sse(
  res: ServerResponse,
  chunks: AsyncIterable<string>,
  signal: AbortSignal,
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    ...CORS,
  });
  try {
    for await (const t of chunks)
      res.write(`data: ${JSON.stringify({ t })}\n\n`);
    res.write("data: [DONE]\n\n");
  } catch (e) {
    if (!signal.aborted) {
      console.error("[relay] /ask failed:", e);
      res.write(
        `data: ${JSON.stringify({ error: "The assistant failed. Try again." })}\n\n`,
      );
    }
  }
  res.end();
}
