import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";

const KEY = "0x" + "a".repeat(64);
const base = {
  ARKIV_HTTP: "https://rpc.example",
  ARKIV_WS: "wss://rpc.example",
  TRUSTED_WORKERS: `0x${"1".repeat(40)}, 0x${"2".repeat(40)}`,
};
const worker = { ...base, WORKER_PRIVATE_KEY: KEY, WORKER_DELAY_BLOCKS: "15" };
const relay = {
  ...base,
  SPONSOR_PRIVATE_KEY: KEY,
  TELEGRAM_BOT_TOKEN: "123:abc-DEF_9",
};

test("valid worker env returns parsed, typed values", () => {
  const c = loadConfig("worker", worker);
  assert.equal(c.delayBlocks, 15);
  assert.equal(c.privateKey, KEY);
  assert.equal(c.accessKey, undefined);
  assert.equal(c.trustedWorkers.length, 2); // workers trust the same wallets as the relay
});

test("valid relay env needs no worker variables", () => {
  const c = loadConfig("relay", relay);
  assert.deepEqual(c.trustedWorkers, [
    `0x${"1".repeat(40)}`,
    `0x${"2".repeat(40)}`,
  ]);
});

test("a missing variable names itself", () => {
  const { WORKER_PRIVATE_KEY, ...env } = worker;
  assert.throws(
    () => loadConfig("worker", env),
    /WORKER_PRIVATE_KEY is missing/,
  );
});

test("every problem is reported in one throw, without leaking values", () => {
  const env = {
    ...worker,
    ARKIV_WS: "https://wrong",
    WORKER_PRIVATE_KEY: "0xsecret",
  };
  assert.throws(
    () => loadConfig("worker", env),
    (e: Error) =>
      /ARKIV_WS must be/.test(e.message) &&
      /WORKER_PRIVATE_KEY must be/.test(e.message) &&
      !e.message.includes("0xsecret"),
  );
});
