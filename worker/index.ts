// Worker entrypoint (LLD §3.2). Run: npm run worker (A) or npm run worker:b (B).
import { mkdir } from "node:fs/promises";
import { publicHttp, publicWs, walletClient } from "../shared/arkiv.ts";
import { loadConfig } from "../shared/config.ts";
import { loadCheckpoint, saveCheckpoint } from "../shared/replay.ts";
import { ExpiryMonitor, Targets } from "./expiry.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { Receipts } from "./receipts.ts";
import { startStream } from "./stream.ts";
import { discoverAll } from "./subs.ts";
import { Writer } from "./writer.ts";

const cfg = loadConfig("worker");
// Built here and handed straight to the writer: no other module touches the wallet (LLD §3.5b).
const wallet = walletClient(cfg.privateKey, cfg.http, cfg.accessKey);
const writer = new Writer(wallet);
const pub = publicHttp(cfg.http, cfg.accessKey);
const address = wallet.account.address;

// Per wallet, like the heartbeat's key file, so A and B can share a machine while testing.
const CHECKPOINT = `state/checkpoint-${address}.json`;
await mkdir("state", { recursive: true });
// First boot: start one hour back (LLD §3.2 step 1).
let checkpoint =
  (await loadCheckpoint(CHECKPOINT)) ?? (await pub.getBlockNumber()) - 1_800n;
let saving = Promise.resolve();

// LLD §3.2 steps 2–3: discover subscriptions, then seed each distinct target (one free read each).
// A target already gone isn't cached; T2.8's startup sequence handles that case.
const subs = await discoverAll(pub);
const targets = new Targets();
const watched = new Set(subs.all().flatMap((s) => s.targetKey ?? []));
const live = await Promise.all([...watched].map((k) => targets.seed(pub, k)));
console.log(
  `[expiry] seeded ${targets.size} targets (${live.filter((ok) => !ok).length} already gone)`,
);

// fire() is called by the expiry monitor and event dispatch (T2.5, T2.7).
const receipts = new Receipts({
  writer,
  pub,
  delayBlocks: cfg.delayBlocks,
  file: `state/pending-${address}.json`,
});
await receipts.resume(); // receipts a crash left unsent
const expiry = new ExpiryMonitor({ pub, targets, subs: () => subs, receipts });

const stopStream = startStream({
  ws: publicWs(cfg.ws),
  http: pub,
  checkpoint: () => checkpoint,
  // Placeholder until the event dispatch (T2.7).
  onEvent: (e) =>
    console.log(`[event] ${e.type} ${e.entityKey} block ${e.blockNumber}`),
  // ponytail: head − 1 counts as fully handled (a block's logs can land just after its head);
  // T2.7 advances the checkpoint only once a block's events are processed.
  onHead: (head) => {
    receipts.onHead(head); // first, so fire() sees this head
    expiry.onHead(head);
    checkpoint = head - 1n;
    const block = checkpoint;
    // Chained, so two saves never race on the same temp file.
    saving = saving
      .then(() => saveCheckpoint(CHECKPOINT, block))
      .catch((e) => console.error("[worker] checkpoint save failed:", e));
  },
});

const stopHeartbeat = await startHeartbeat(writer, pub, cfg, address);

// Exiting mid-write is safe: the writer re-reads the nonce from the chain on the next start.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    console.log(`[worker] ${signal}, stopping`);
    stopStream();
    stopHeartbeat();
    process.exit(0);
  });
