// Measures what the LLD takes on trust (T0.3). Each check prints one result line.
// Run: npm run probe   (writes one short-lived entity with WORKER_A; costs ~0.0001 GLM)
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PROJECT } from "../shared/schema.ts";

const url = process.env.ARKIV_HTTP!;
const apiKey = process.env.ARKIV_ACCESS_KEY_A!;
const transport = http(url, {
  fetchOptions: { headers: { "X-API-KEY": apiKey } },
});
const pub = createPublicClient({ chain: tiramisu, transport });
const wallet = createWalletClient({
  chain: tiramisu,
  transport,
  account: privateKeyToAccount(
    process.env.WORKER_A_PRIVATE_KEY as `0x${string}`,
  ),
});

// One raw JSON-RPC call, returning the body and any Arkiv-* response headers.
async function rpc(method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const headers = [...res.headers].filter(([k]) => k.startsWith("arkiv"));
  return { status: res.status, headers, body: await res.text() };
}

const line = (n: string, msg: unknown) =>
  console.log(`[${n}]`, typeof msg === "string" ? msg : JSON.stringify(msg));

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

// 1c. The cost header on the call the SDK actually makes.
const q = await rpc("arkiv_query", [`$key = ${entityKey}`, { limit: 1 }]);
line("1c arkiv_query headers", { status: q.status, headers: q.headers });

// 6. eth_getLogs over the whole chain: what does the "too many results" error look like?
line(
  "6 getLogs 0..latest",
  (
    await rpc("eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest" }])
  ).body.slice(0, 300),
);
