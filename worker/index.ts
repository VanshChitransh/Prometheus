// Worker entrypoint (LLD §3.2). Run: npm run worker (A) or npm run worker:b (B).
import { mkdir } from "node:fs/promises";
import { publicHttp, publicWs, walletClient } from "../shared/arkiv.ts";
import { loadConfig } from "../shared/config.ts";
import { loadCheckpoint, saveCheckpoint } from "../shared/replay.ts";
import { createDispatch } from "./events.ts";
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
// Our own receipts must count in the dedupe check, or every restart would write them again.
if (!cfg.trustedWorkers.some((a) => a.toLowerCase() === address.toLowerCase()))
  throw new Error(
    `TRUSTED_WORKERS must include this worker's address ${address}`,
  );

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
  trustedWorkers: cfg.trustedWorkers,
});
await receipts.resume(); // receipts a crash left unsent
const expiry = new ExpiryMonitor({ pub, targets, subs: () => subs, receipts });
const dispatch = createDispatch({ pub, subs: () => subs, targets });

const stopStream = startStream({
  ws: publicWs(cfg.ws),
  http: pub,
  checkpoint: () => checkpoint,
  onEvent: dispatch.onEvent,
  onHead: (head) => {
    receipts.onHead(head); // first, so fire() sees this head
    expiry.onHead(head);
    // head − 1 is complete once its events are handled (a block's logs can land just after its
    // head); only then may the checkpoint pass it. Chained: in order, never two saves at once.
    const block = head - 1n;
    saving = saving
      .then(() => dispatch.settle(block))
      .then(() => {
        if (block <= checkpoint) return; // a repeated head after a reconnect
        checkpoint = block;
        return saveCheckpoint(CHECKPOINT, block);
      })
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
