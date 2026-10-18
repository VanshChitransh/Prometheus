import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicArkivClient } from "@arkiv-network/sdk";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { publicHttp, rawGetEntity, retryAfter } from "./arkiv.ts";

const A = "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B";
const KEY = `0x${"a".repeat(64)}` as const;

// A node answering arkiv_getEntity with `result`, in the shape measured on 16 Oct.
const node = (result: unknown) =>
  ({ request: async () => result }) as unknown as PublicArkivClient;
const entity = (creationFlags: unknown) => ({
  key: KEY,
  owner: A.toLowerCase(),
  creator: A.toLowerCase(),
  createdAt: "0x10",
  expiresAt: "0x20",
  creationFlags,
  payload: "0x",
  attributes: [{ name: "lead_blocks", type: "u64", value: "0x1e" }],
});

test("head reads aren't cached: viem's default held them 4 s (~2 blocks)", () => {
  assert.equal(publicHttp("https://rpc.example").cacheTime, 0);
});

test("rawGetEntity decodes the node's raw entity", async () => {
  const e = await rawGetEntity(node(entity({ raw: 0 })), KEY);
  assert.equal(e?.creator, A); // checksummed, like TRUSTED_WORKERS
  assert.equal(e?.expiresAt, 32n);
  assert.equal(e?.attributes.lead_blocks, 30n); // u64 arrives as a 0x quantity
  assert.equal(e?.types?.lead_blocks, "u64");
  assert.equal(await rawGetEntity(node(null), KEY), null);
});

test("rawGetEntity reads creationFlags in every form the SDK accepts", async () => {
  for (const flags of [
    2, // the byte
    { raw: 2 },
    { readonly: false, permissionlessExtension: true, raw: 2 }, // what the node sends today
    { permissionlessExtension: true },
  ]) {
    const e = await rawGetEntity(node(entity(flags)), KEY);
    assert.deepEqual(
      e?.flags,
      { readonly: false, permissionlessExtension: true },
      JSON.stringify(flags),
    );
  }
  const none = await rawGetEntity(node(entity(undefined)), KEY);
  assert.deepEqual(none?.flags, {
    readonly: false,
    permissionlessExtension: false,
  });
});

test("retryAfter finds Arkiv's 429 through viem and RpcError, and nothing else", async () => {
  // Answers like the node did on 18 Oct once this IP's anonymous budget was spent.
  const server = createServer((_, res) => {
    res.writeHead(429, {
      "retry-after": "2000",
      "content-type": "application/json",
    });
    res.end('{"error":"ANON_COST_LIMITED"}');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const client = publicHttp(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  try {
    const viaSdk = await client.query("project = str('x')").catch((e) => e);
    assert.equal(retryAfter(viaSdk), 2000);
    const viaRaw = await rawGetEntity(client, KEY).catch((e) => e);
    assert.equal(retryAfter(viaRaw), 2000);
    assert.equal(retryAfter(new Error("boom")), undefined);
  } finally {
    server.close();
  }
});
