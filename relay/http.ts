// The relay's HTTP API (LLD §6.2): GET /health and POST /sponsor. Node only.
// A request handler, not a server: index.ts listens, tests mount it on a throwaway port.
import type { IncomingMessage, RequestListener } from "node:http";
import type { SponsorReply } from "./sponsor.ts";

const MAX_BODY = 8_192; // bytes; a /sponsor body is ~1 KB
// /health is public and each lookup spends quota (one free count per worker), so callers share one
// answer for this long: hammering the endpoint can't drain the quota delivery depends on.
const HEALTH_TTL_MS = 30_000;

// Refused past MAX_BODY before parsing, so nobody can stream junk into memory.
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RangeError("body too large");
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
      await route(req, json, () => {
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
    json: (status: number, body: unknown) => void,
    preflight: () => void,
  ) {
    if (!URL.canParse(req.url ?? "/", "http://relay"))
      return json(400, { error: "Bad request." });
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    if (req.method === "OPTIONS") return preflight();
    if (req.method === "POST" && path === "/sponsor") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (e) {
        return e instanceof RangeError
          ? json(413, { error: "Request too large." })
          : json(400, { error: "Send JSON." });
      }
      const r = await o.sponsor(body); // a throw is answered 500 by the caller
      return json(r.status, r.body);
    }
    if (req.method === "GET" && path === "/health")
      return json(200, { ok: true, workersAlive: await workersAlive() });
    json(404, { error: "not found" });
  }
}
