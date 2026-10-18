import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST } from "./rpc.ts";

const call = (body = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}') =>
  POST(new Request("http://x/api/rpc", { method: "POST", body }));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ARKIV_ACCESS_KEY;
});

test("refuses without a key, so the browser falls back to its own quota", async () => {
  globalThis.fetch = () => assert.fail("must not call Arkiv keyless");
  assert.equal((await call()).status, 503);
});

test("forwards the body with the key and passes a 429's Retry-After through", async () => {
  process.env.ARKIV_ACCESS_KEY = " k ";
  let sent: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    sent = init;
    return new Response("{}", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  };
  const r = await call();
  assert.equal((sent!.headers as Record<string, string>)["X-API-KEY"], "k");
  assert.match(String(sent!.body), /eth_blockNumber/);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60");
});

test("refuses oversized bodies", async () => {
  process.env.ARKIV_ACCESS_KEY = "k";
  assert.equal((await call("x".repeat(70_000))).status, 413);
});
