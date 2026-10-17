// Worker entrypoint (LLD §3.2). Run: npm run worker (A) or npm run worker:b (B).
import { mkdir } from "node:fs/promises";
import { publicHttp, publicWs, walletClient } from "../shared/arkiv.ts";
import { loadConfig } from "../shared/config.ts";
import { loadCheckpoint, saveCheckpoint } from "../shared/replay.ts";
import { createDispatch } from "./events.ts";
import { ExpiryMonitor, Targets } from "./expiry.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { Keeper } from "./keeper.ts";
import { Receipts } from "./receipts.ts";
import { rebuildDayCounts, seedTargets, startResync } from "./startup.ts";
import { startStream } from "../shared/stream.ts";
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

// LLD §3.2 steps 2–3: discover subscriptions, then seed each distinct target, including ones that
// expired while we were down. `let`: the hourly re-sync swaps in a fresh index.
let { subs } = await discoverAll(pub);
const targets = new Targets();
const head = await pub.getBlockNumber();
await seedTargets(pub, subs, targets, head);

// fire() is called by the expiry monitor and event dispatch (T2.5, T2.7).
const receipts = new Receipts({
  writer,
  pub,
  delayBlocks: cfg.delayBlocks,
  file: `state/pending-${address}.json`,
  trustedWorkers: cfg.trustedWorkers,
  // Extends `keep` targets through the same writer (one wallet, one nonce queue).
  keeper: new Keeper({ writer, pub, targets, address }),
});
await receipts.resume(); // receipts a crash left unsent
// LLD §3.2 step 4: today's counts, so a restart doesn't reset max_per_day.
await rebuildDayCounts(pub, subs, receipts, head, cfg.trustedWorkers);
const expiry = new ExpiryMonitor({ pub, targets, subs: () => subs, receipts });
const dispatch = createDispatch({
  pub,
  subs: () => subs,
  targets,
  receipts,
  trustedWorkers: cfg.trustedWorkers,
  headNow: () => pub.getBlockNumber(),
});

const stopStream = startStream({
  ws: publicWs(cfg.ws),
  http: pub,
  checkpoint: () => checkpoint,
  onEvent: dispatch.onEvent,
  // The receipt flush only needs the clock, so it gets every head, even while catching up.
  // Called before onHead, so fire() sees this head.
  onRawHead: (head) => receipts.onHead(head),
  onHead: (head) => {
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
// LLD §3.2 step 6: re-discover and re-seed hourly (expired subscriptions emit no event).
const stopResync = startResync({
  pub,
  subs: () => subs,
  setSubs: (fresh) => (subs = fresh),
  targets,
});

// Graceful: stop taking work, then give the outbox one last flush and let the pending file and the
// checkpoint finish writing (≤ 5 s). Exiting mid-write is still safe: the writer re-reads the nonce
// on the next start, and resume() re-sends whatever the pending file holds.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    console.log(`[worker] ${signal}, stopping`);
    stopStream();
    stopHeartbeat();
    stopResync();
    await Promise.race([
      Promise.all([receipts.close(), saving]),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    process.exit(0);
  });
