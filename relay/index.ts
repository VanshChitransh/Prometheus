// Relay entrypoint (LLD §6.2): one process for the bot, receipt delivery and the HTTP API.
// Run: npm run relay.
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { freeCount, publicHttp, publicWs } from "../shared/arkiv.ts";
import { loadConfig } from "../shared/config.ts";
import { PROJECT } from "../shared/schema.ts";
import { createBot } from "./bot.ts";
import { openDb } from "./db.ts";
import { startDelivery } from "./deliver.ts";

const DAY_MS = 86_400_000;

const cfg = loadConfig("relay");
const db = openDb(cfg.dbPath);
const pub = publicHttp(cfg.http, cfg.accessKey);

// Delivered ids are only needed while a replay could still bring their receipt back.
const prune = () => {
  try {
    const n = db.pruneDelivered();
    if (n) console.log(`[relay] pruned ${n} delivered ids older than 30 days`);
  } catch (e) {
    console.error("[relay] prune failed:", e);
  }
};
prune();
const pruneTimer = setInterval(prune, DAY_MS);

const bot = createBot(cfg.telegramToken, db, pub);
// The command menu; cosmetic, so a failure only warns.
await bot.api
  .setMyCommands([
    { command: "list", description: "What you follow" },
    { command: "stop", description: "Stop following one: /stop <number>" },
  ])
  .catch((e) => console.warn("[relay] setMyCommands failed:", e));

const stopDelivery = await startDelivery({
  ws: publicWs(cfg.ws),
  http: pub,
  db,
  trusted: cfg.trustedWorkers,
  // Next to the DB, so both live on the host's volume and survive a redeploy together.
  checkpointFile: join(dirname(cfg.dbPath), "relay-checkpoint.json"),
  send: (chatId, text) =>
    bot.api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
    }),
});

// Long polling: no public URL or webhook needed. start() resolves only when the bot stops, and
// rejects on a bad token or a second instance polling the same bot: fatal either way.
bot
  .start({
    onStart: (me) => console.log(`[relay] bot @${me.username} polling`),
  })
  .catch((e) => {
    console.error("[relay] bot stopped:", e);
    process.exit(1);
  });

// A worker is alive while its `worker` heartbeat entity exists: it expires 30 min after the last
// beat (worker/heartbeat.ts). A free filtered count, so the relay needs no heartbeat keys.
const workersAlive = async () => {
  const alive = await Promise.all(
    cfg.trustedWorkers.map(
      async (w) =>
        (await freeCount(
          pub,
          `project = str('${PROJECT}') AND kind = str('worker') AND $creator = addr(${w})`,
        )) > 0,
    ),
  );
  return cfg.trustedWorkers.filter((_, i) => alive[i]);
};

// `ok` means the relay is up. An Arkiv outage reports workersAlive: null rather than failing the
// check: restarting the relay can't fix the node.
const server = createServer(async (req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*", // public, read-only; the web app reads it cross-origin
    });
    res.end(JSON.stringify(body));
  };
  const path = new URL(req.url ?? "/", "http://relay").pathname;
  if (req.method === "GET" && path === "/health") {
    const alive = await workersAlive().catch((e) => {
      console.error("[relay] /health worker check failed:", e);
      return null;
    });
    return json(200, { ok: true, workersAlive: alive });
  }
  json(404, { error: "not found" });
});
server.listen(cfg.port, () =>
  console.log(`[relay] http on :${cfg.port} (GET /health)`),
);

// Graceful: stop taking updates and events, let the delivery chain and checkpoint finish (≤ 5 s),
// then close the DB. DMs still queued are lost (see deliver.ts).
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    console.log(`[relay] ${signal}, stopping`);
    clearInterval(pruneTimer);
    server.close();
    await Promise.race([
      Promise.all([bot.stop(), stopDelivery()]),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    db.close();
    process.exit(0);
  });
