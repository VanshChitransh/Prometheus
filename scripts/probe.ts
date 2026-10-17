// Measures what the LLD takes on trust (T0.3). Each check prints one result line.
// Run: npm run probe   (writes one short-lived entity with worker A; costs ~0.0001 GLM)
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
import {
  freeCount,
  publicHttp,
  rawGetEntity,
  walletClient,
} from "../shared/arkiv.ts";
import { loadConfig } from "../shared/config.ts";
import { PROJECT } from "../shared/schema.ts";

const cfg = loadConfig("worker");
const pub = publicHttp(cfg.http, cfg.accessKey);
const wallet = walletClient(cfg.privateKey, cfg.http, cfg.accessKey);

// The probe writes with worker A's wallet outside the worker's Writer, so a running worker A would
// race it for nonces. A live heartbeat entity means it runs (or stopped < 30 min ago, while the
// entity lapses): refuse rather than risk a stuck nonce in the real worker.
const live = await freeCount(
  pub,
  `project = str('${PROJECT}') AND kind = str('worker') AND $creator = addr(${wallet.account.address})`,
);
if (live > 0) {
  console.error(
    `[probe] worker ${wallet.account.address} looks alive (its heartbeat entity is live). Stop it, wait for the entity to lapse (≤ 30 min), then rerun.`,
  );
  process.exit(1);
}

// One raw JSON-RPC call, returning the body and any Arkiv-* response headers.
// Kept beside the shared clients on purpose: lines 1b, 1c and 6 measure headers and raw errors,
// which the clients hide.
async function rpc(method: string, params: unknown[]) {
  const res = await fetch(cfg.http, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.accessKey && { "X-API-KEY": cfg.accessKey }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const headers = [...res.headers].filter(([k]) => k.startsWith("arkiv"));
  return { status: res.status, headers, body: await res.text() };
}

const line = (n: string, msg: unknown) =>
  console.log(
    `[${n}]`,
    typeof msg === "string"
      ? msg
      : JSON.stringify(msg, (_, v) => (typeof v === "bigint" ? String(v) : v)),
  );

// Setup: one entity to inspect.
const { entityKey, txHash } = await wallet.createEntity({
  payload: jsonToPayload({ probe: true }),
  contentType: "application/json",
  attributes: { project: PROJECT, kind: "probe" },
  expires: ExpirationTime.fromMinutes(10),
});
line("setup", { entityKey, txHash, sdk: "0.8.1", node: process.version });

// 1a. SDK getEntity (arkiv_query under the hood): which fields come back?
const e = await pub.getEntity(entityKey);
line("1a sdk getEntity", {
  expiresAt: String(e.expiresAt),
  creator: e.creator,
  owner: e.owner,
  creationFlags: e.creationFlags,
  attributes: e.attributes,
});

// 1b. Raw arkiv_getEntity, which the LLD assumes exists and is free.
line("1b raw arkiv_getEntity", await rpc("arkiv_getEntity", [entityKey]));

// 1c. The cost header on the call the SDK actually makes. The node wants typed literals and a hex
// limit: a bare `$key = 0x…` is refused (-32001), yet still billed, so it measured nothing (audit).
const q = await rpc("arkiv_query", [
  `$key = key(${entityKey})`,
  { limit: "0x1" },
]);
line("1c arkiv_query headers", { status: q.status, headers: q.headers });

// 1d–1f. The shared free calls (T1.2), checked against the live node.
line("1d rawGetEntity", await rawGetEntity(pub, entityKey));
line("1e rawGetEntity missing", await rawGetEntity(pub, `0x${"1".repeat(64)}`));
line(
  "1f freeCount",
  await freeCount(pub, `project = str('${PROJECT}') AND kind = str('probe')`),
);

// 6. eth_getLogs over the whole chain: what does the "too many results" error look like?
line(
  "6 getLogs 0..latest",
  (
    await rpc("eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest" }])
  ).body.slice(0, 300),
);
