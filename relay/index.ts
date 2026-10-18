// Relay entrypoint (LLD §6.2): one process for the bot, receipt delivery and the HTTP API.
// Run: npm run relay.
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { formatEther, parseEther } from "viem";
import {
  freeCount,
  publicHttp,
  publicWs,
  walletClient,
} from "../shared/arkiv.ts";
import { loadConfig } from "../shared/config.ts";
import { PROJECT } from "../shared/schema.ts";
import { createBot } from "./bot.ts";
import { openDb } from "./db.ts";
import { startDelivery } from "./deliver.ts";
import { createAsk, loadDocs, openRouterAnswer } from "./ask.ts";
import { createHttpHandler } from "./http.ts";
import { createSubscribe } from "./newsletter.ts";
import { createSponsor } from "./sponsor.ts";

const DAY_MS = 86_400_000;

const cfg = loadConfig("relay");
const db = openDb(cfg.dbPath);
const pub = publicHttp(cfg.http, cfg.accessKey);

// Its own wallet, never a worker's: sponsoring can't starve the workers' gas.
const sponsorWallet = walletClient(cfg.sponsorKey, cfg.http, cfg.accessKey);
const sponsor = createSponsor({
  db,
  pub,
  botToken: cfg.telegramToken,
  send: (to, value) => sponsorWallet.sendTransaction({ to, value }),
});
pub
  .getBalance({ address: sponsorWallet.account.address })
  .then((b) => {
    const log = b < parseEther("0.1") ? console.warn : console.log;
    log(
      `[relay] sponsor ${sponsorWallet.account.address} holds ${formatEther(b)} GLM`,
    );
  })
  .catch((e) => console.warn("[relay] sponsor balance check failed:", e));

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
// The Mini App's launch button beside the chat input; without WEB_URL, set it in @BotFather instead.
if (cfg.webUrl)
  await bot.api
    .setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "Open Prometheus",
        web_app: { url: cfg.webUrl },
      },
    })
    .catch((e) => console.warn("[relay] setChatMenuButton failed:", e));

const stopDelivery = await startDelivery({
  ws: publicWs(cfg.ws),
  http: pub,
  db,
  trusted: cfg.trustedWorkers,
  // Next to the DB, so both live on the host's volume and survive a redeploy together.
  checkpointFile: join(dirname(cfg.dbPath), "relay-checkpoint.json"),
  webUrl: cfg.webUrl,
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

// The docs assistant reads web/docs from the image (Dockerfile), so it answers from the docs of this deploy.
const ask = cfg.openrouterKey
  ? createAsk({
      answer: openRouterAnswer(
        cfg.openrouterKey,
        loadDocs(new URL("../web/docs/", import.meta.url), cfg.webUrl),
        cfg.askModels,
      ),
      dailyCap: cfg.askDailyCap,
    })
  : undefined;
if (!ask) console.warn("[relay] OPENROUTER_API_KEY not set: POST /ask is off");

const subscribe = createSubscribe({ db });

const server = createServer(
  createHttpHandler({ sponsor, workersAlive, ask, subscribe }),
);
server.listen(cfg.port, () =>
  console.log(
    `[relay] http on :${cfg.port} (GET /health, POST /sponsor, POST /ask, POST /subscribe)`,
  ),
);

// Graceful: stop taking updates and events, let the delivery chain, checkpoint and queued DMs
// finish (≤ 5 s), then close the DB. DMs still queued after that are lost (see deliver.ts).
// allSettled, not all: bot.stop() makes one last Telegram call, and if that rejects, all() would
// skip the rest of the shutdown.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    console.log(`[relay] ${signal}, stopping`);
    clearInterval(pruneTimer);
    server.close();
    await Promise.race([
      Promise.allSettled([bot.stop(), stopDelivery()]),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    db.close();
    process.exit(0);
  });
