import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseEther, type Hex } from "viem";
import { openDb } from "./db.ts";
import {
  createSponsor,
  FAUCET,
  SPONSOR_AMOUNT,
  verifyInitData,
} from "./sponsor.ts";

const TOKEN = "123:abc-DEF_9";
const NOW = 1_700_000_000; // seconds
const TX: Hex = `0x${"e".repeat(64)}`;
const addr = (c: string): Hex => `0x${c.repeat(40)}`;

// Signs like Telegram does: fields sorted by key, key=value lines, HMAC keyed by
// HMAC("WebAppData", token).
function initData(
  over: Record<string, string> = {},
  { id = 42, token = TOKEN } = {},
) {
  const fields: Record<string, string> = {
    auth_date: String(NOW),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({ id, first_name: "Ann" }),
    ...over,
  };
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

test("a valid initData gives the Telegram user id", () => {
  assert.equal(verifyInitData(initData(), TOKEN, NOW), 42);
  assert.equal(verifyInitData(initData(), TOKEN, NOW + 3_000), 42); // 50 min old
});

test("fields are checked in key order, as Telegram signs them", () => {
  // "a1=" sorts before "a=" as text, but key "a" comes before "a1".
  const data = initData({ a: "x", a1: "y" });
  assert.equal(verifyInitData(data, TOKEN, NOW), 42);
});

test("a tampered, stale, future, foreign or unsigned initData is refused", () => {
  const tampered = initData().replace("%22id%22%3A42", "%22id%22%3A43");
  assert.notEqual(tampered, initData());
  for (const bad of [
    tampered, // another user id under the old hash
    initData({ auth_date: String(NOW + 600) }), // 10 min in the future
    initData({}, { token: "999:other" }), // signed for another bot
    initData().replace(/&hash=[0-9a-f]+/, ""), // no hash
    initData().replace(/hash=[0-9a-f]+/, "hash=zz"), // malformed hash
    initData({ user: "not json" }),
    initData({}, { id: -5 }),
    "",
  ])
    assert.equal(verifyInitData(bad, TOKEN, NOW), null, bad);
  // Genuine but over an hour old: told apart, so the reply can say "reopen it".
  const old = initData({ auth_date: String(NOW - 7_200) });
  assert.equal(verifyInitData(old, TOKEN, NOW), "stale");
  assert.equal(verifyInitData(old.replace("Ann", "Bob"), TOKEN, NOW), null);
});

// --- the handler, with a stubbed chain and an in-memory DB ---

function setup({ balance = 0n } = {}) {
  const db = openDb(":memory:", () => NOW * 1_000);
  const log: string[] = [];
  let broken = false;
  let lookups = 0;
  const handle = createSponsor({
    db,
    botToken: TOKEN,
    now: () => NOW * 1_000,
    pub: {
      getBalance: async () => (lookups++, balance),
      waitForTransactionReceipt: (async ({ hash }: { hash: Hex }) => {
        await new Promise((r) => setTimeout(r, 5));
        log.push(`mined ${hash.slice(0, 4)}`);
      }) as never,
    },
    send: async (to) => {
      log.push(`send ${to.slice(0, 4)}`);
      if (broken) throw new Error("rpc down");
      return `0x${to.slice(2, 3).repeat(64)}` as Hex;
    },
  });
  return {
    db,
    log,
    handle,
    breakSend: (b: boolean) => (broken = b),
    lookups: () => lookups,
  };
}

const req = (address: string, id = 42) => ({
  address,
  initData: initData({}, { id }),
});

test("a valid request sends 0.02 GLM and returns the tx", async () => {
  const { handle, db } = setup();
  const r = await handle(req(addr("1")));
  assert.equal(r.status, 200);
  assert.equal(r.body.tx, `0x${"1".repeat(64)}`);
  assert.equal(db.sponsoredLast24h(), SPONSOR_AMOUNT);
});

test("bad bodies, bad initData and bad addresses send nothing", async () => {
  const { handle, log } = setup();
  assert.equal((await handle(null)).status, 400);
  assert.equal((await handle({ address: addr("1") })).status, 400);
  assert.equal(
    (await handle({ address: addr("1"), initData: "hash=00" })).status,
    401,
  );
  assert.equal((await handle(req("0x1234"))).status, 400);
  const stale = await handle({
    address: addr("1"),
    initData: initData({ auth_date: String(NOW - 7_200) }),
  });
  assert.equal(stale.status, 401);
  assert.match(String(stale.body.error), /over an hour old/);
  assert.deepEqual(log, []);
});

test("a second claim by the same user or for the same address is refused", async () => {
  const { handle } = setup();
  assert.equal((await handle(req(addr("1"), 1))).status, 200);
  const again = await handle(req(addr("2"), 1)); // same user
  assert.equal(again.status, 409);
  assert.equal(again.body.faucet, FAUCET); // a lost transfer still has a way out
  assert.equal((await handle(req(addr("1"), 2))).status, 409); // same address
});

test("an already sponsored user or a spent cap costs no balance lookup", async () => {
  const { handle, db, lookups } = setup();
  assert.equal((await handle(req(addr("1"), 1))).status, 200);
  assert.equal((await handle(req(addr("2"), 1))).status, 409); // same user
  assert.equal((await handle(req(addr("1"), 2))).status, 409); // same address
  db.claimSponsor(7, addr("7"), parseEther("0.98")); // the day's 1 GLM is now spent
  assert.equal((await handle(req(addr("3"), 3))).status, 429);
  assert.equal(lookups(), 1);
});

test("an already funded wallet is refused and claims nothing", async () => {
  const { handle, db, log } = setup({ balance: parseEther("0.01") });
  const r = await handle(req(addr("1")));
  assert.equal(r.status, 409);
  assert.equal(db.sponsoredLast24h(), 0n);
  assert.deepEqual(log, []);
});

test("the 1 GLM / 24 h cap answers 429 with the faucet", async () => {
  const { handle, db, log } = setup();
  db.claimSponsor(7, addr("7"), parseEther("0.99"));
  const r = await handle(req(addr("1")));
  assert.equal(r.status, 429);
  assert.equal(r.body.faucet, FAUCET);
  assert.deepEqual(log, []);
});

test("a failed send frees the claim, so a retry works", async () => {
  const { handle, breakSend } = setup();
  const log = console.error;
  console.error = () => {}; // the failure is logged; keep test output clean
  try {
    breakSend(true);
    const r = await handle(req(addr("1")));
    assert.equal(r.status, 503);
    assert.equal(r.body.faucet, FAUCET); // an empty sponsor wallet isn't "try again" forever
  } finally {
    console.error = log;
  }
  breakSend(false);
  assert.equal((await handle(req(addr("1")))).status, 200);
});

test("two requests at once: the second transfer starts after the first is mined", async () => {
  const { handle, log } = setup();
  const [a, b] = await Promise.all([
    handle(req(addr("1"), 1)),
    handle(req(addr("2"), 2)),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  await new Promise((r) => setTimeout(r, 20)); // let the last receipt land
  assert.deepEqual(log, ["send 0x11", "mined 0x11", "send 0x22", "mined 0x22"]);
});

test("a confirm cut short by an RPC error still holds the next transfer for the window", async () => {
  const sent: number[] = [];
  const handle = createSponsor({
    db: openDb(":memory:", () => NOW * 1_000),
    botToken: TOKEN,
    now: () => NOW * 1_000,
    confirmMs: 50,
    pub: {
      getBalance: async () => 0n,
      waitForTransactionReceipt: (async () => {
        throw new Error("HTTP request failed. Status: 429"); // retryCount 0: one 429 ends the wait
      }) as never,
    },
    send: async (to) => {
      sent.push(performance.now());
      return `0x${to.slice(2, 3).repeat(64)}` as Hex;
    },
  });
  const log = console.error;
  console.error = () => {}; // the failed confirm is logged; keep test output clean
  try {
    await Promise.all([handle(req(addr("1"), 1)), handle(req(addr("2"), 2))]);
  } finally {
    console.error = log;
  }
  assert.equal(sent.length, 2);
  // The first transfer may still be unmined: a second send now could reuse its pending nonce.
  assert.ok(
    sent[1]! - sent[0]! >= 45,
    `second send after ${sent[1]! - sent[0]!} ms`,
  );
});
