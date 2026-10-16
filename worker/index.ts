// Worker entrypoint (LLD §3.2). Run: npm run worker (A) or npm run worker:b (B).
import { publicHttp, walletClient } from "../shared/arkiv.ts";
import { loadConfig } from "../shared/config.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { Writer } from "./writer.ts";

const cfg = loadConfig("worker");
// Built here and handed straight to the writer: no other module touches the wallet (LLD §3.5b).
const wallet = walletClient(cfg.privateKey, cfg.http, cfg.accessKey);
const writer = new Writer(wallet);
const pub = publicHttp(cfg.http, cfg.accessKey);

const stopHeartbeat = await startHeartbeat(
  writer,
  pub,
  cfg,
  wallet.account.address,
);

// Exiting mid-write is safe: the writer re-reads the nonce from the chain on the next start.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    console.log(`[worker] ${signal}, stopping`);
    stopHeartbeat();
    process.exit(0);
  });
