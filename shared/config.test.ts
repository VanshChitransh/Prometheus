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

test("relay dbPath defaults to state/ and can be overridden", () => {
  assert.equal(loadConfig("relay", relay).dbPath, "state/relay.db");
  const c = loadConfig("relay", { ...relay, RELAY_DB_PATH: "/data/relay.db" });
  assert.equal(c.dbPath, "/data/relay.db");
});

test("relay port defaults to 8080, takes PORT, and rejects a bad one", () => {
  assert.equal(loadConfig("relay", relay).port, 8080);
  assert.equal(loadConfig("relay", { ...relay, PORT: "3000" }).port, 3000);
  assert.throws(
    () => loadConfig("relay", { ...relay, PORT: "70000" }),
    /PORT must be/,
  );
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

test("TRUSTED_WORKERS: a mistyped checksum is rejected; lowercase is normalized to checksummed", () => {
  const good = "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B";
  const typo = "0x6a693fd642c1F8F5E78321C2722208A3791eE79B"; // one letter's case flipped
  assert.throws(
    () => loadConfig("worker", { ...worker, TRUSTED_WORKERS: typo }),
    /TRUSTED_WORKERS must be/,
  );
  const c = loadConfig("worker", {
    ...worker,
    TRUSTED_WORKERS: good.toLowerCase(),
  });
  assert.deepEqual(c.trustedWorkers, [good]);
});

test("relay WEB_URL is optional and must be https (Telegram opens Mini Apps over https only)", () => {
  assert.equal(loadConfig("relay", relay).webUrl, undefined);
  assert.equal(
    loadConfig("relay", { ...relay, WEB_URL: "https://app.example" }).webUrl,
    "https://app.example",
  );
  assert.throws(
    () => loadConfig("relay", { ...relay, WEB_URL: "http://app.example" }),
    /WEB_URL must be an https:\/\/ URL/,
  );
});

test("the worker's version is GIT_SHA, the commit it was built from, or dev without it (WK-11)", () => {
  assert.equal(loadConfig("worker", worker).version, "dev");
  assert.equal(
    loadConfig("worker", { ...worker, GIT_SHA: "78bc187" }).version,
    "78bc187",
  );
  assert.throws(
    () => loadConfig("worker", { ...worker, GIT_SHA: "x".repeat(200) }),
    /GIT_SHA must be/,
  );
});
