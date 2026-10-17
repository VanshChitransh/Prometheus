import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";

const SUB = `0x${"a".repeat(64)}`;
const SUB2 = `0x${"b".repeat(64)}`;
const SUB0 = `0x${"0".repeat(64)}`;
const ADDR = `0x${"Ab".repeat(20)}`; // mixed case on purpose
const OTHER = `0x${"c".repeat(40)}`;
const DAY_MS = 86_400_000;

test("follow is idempotent; chatsFor lists every follower", () => {
  const db = openDb(":memory:");
  db.follow(1, SUB);
  db.follow(1, SUB);
  db.follow(2, SUB);
  assert.deepEqual(db.listFollows(1), [SUB]);
  assert.deepEqual(db.chatsFor(SUB).sort(), [1, 2]);
  assert.deepEqual(db.chatsFor(SUB2), []);
});

test("keys are matched case-insensitively", () => {
  const db = openDb(":memory:");
  db.follow(1, SUB.toUpperCase());
  assert.deepEqual(db.chatsFor(SUB), [1]);
});

test("unfollow reports whether the follow existed", () => {
  const db = openDb(":memory:");
  db.follow(1, SUB);
  assert.equal(db.unfollow(1, SUB), true);
  assert.equal(db.unfollow(1, SUB), false);
  assert.deepEqual(db.chatsFor(SUB), []);
});

test("listFollows is in follow order, same-second ties broken by key", () => {
  let t = 0;
  const db = openDb(":memory:", () => t);
  db.follow(1, SUB2);
  db.follow(1, SUB);
  t = 5_000;
  db.follow(1, SUB0);
  assert.deepEqual(db.listFollows(1), [SUB, SUB2, SUB0]);
});

test("markDelivered is true only the first time", () => {
  const db = openDb(":memory:");
  assert.equal(db.markDelivered(SUB), true);
  assert.equal(db.markDelivered(SUB), false);
  assert.equal(db.markDelivered(SUB2), true);
});

test("claimSponsor refuses a second claim by the same user or for the same address", () => {
  const db = openDb(":memory:");
  assert.equal(db.claimSponsor(1, ADDR, 2n), true);
  assert.equal(db.claimSponsor(1, OTHER, 2n), false); // same user
  assert.equal(db.claimSponsor(2, ADDR.toLowerCase(), 2n), false); // same address, other case
  assert.equal(db.claimSponsor(2, OTHER, 2n), true);
});

test("isSponsored matches a claim by the same user or for the same address, in any case", () => {
  const db = openDb(":memory:");
  assert.equal(db.isSponsored(1, ADDR), false);
  db.claimSponsor(1, ADDR, 2n);
  assert.equal(db.isSponsored(1, OTHER), true); // same user
  assert.equal(db.isSponsored(2, ADDR.toLowerCase()), true); // same address, other case
  assert.equal(db.isSponsored(2, OTHER), false);
});

test("releaseSponsor frees both the user and the address; others stay claimed", () => {
  const db = openDb(":memory:");
  db.claimSponsor(1, ADDR, 2n);
  db.claimSponsor(2, OTHER, 2n);
  db.releaseSponsor(1);
  assert.equal(db.sponsoredLast24h(), 2n);
  assert.equal(db.claimSponsor(3, ADDR, 2n), true); // the address is free again
  assert.equal(db.claimSponsor(2, `0x${"d".repeat(40)}`, 2n), false);
});

test("recordSponsorTx keeps the claim and its amount", () => {
  const db = openDb(":memory:");
  db.claimSponsor(1, ADDR, 5n);
  db.recordSponsorTx(1, `0x${"e".repeat(64)}`);
  assert.equal(db.sponsoredLast24h(), 5n);
  assert.equal(db.claimSponsor(1, OTHER, 5n), false);
});

test("pruneDelivered drops rows older than 30 days and keeps newer ones", () => {
  let t = 0;
  const db = openDb(":memory:", () => t);
  db.markDelivered("old");
  t = 20 * DAY_MS;
  db.markDelivered("new");
  t = 31 * DAY_MS;
  assert.equal(db.pruneDelivered(), 1);
  assert.equal(db.markDelivered("old"), true); // gone
  assert.equal(db.markDelivered("new"), false); // kept
});

test("sponsoredLast24h sums exact wei from the last 24 h only", () => {
  let t = 0;
  const db = openDb(":memory:", () => t);
  const wei = 20_000_000_000_000_001n; // above 2^53: a float sum would lose the trailing 1
  db.claimSponsor(1, ADDR, wei);
  t = 2 * DAY_MS;
  db.claimSponsor(2, OTHER, wei);
  db.claimSponsor(3, `0x${"d".repeat(40)}`, wei);
  assert.equal(db.sponsoredLast24h(), 2n * wei);
});

test("a file DB keeps delivered ids across close and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-db-"));
  try {
    const path = join(dir, "nested", "relay.db"); // the missing folder is created
    const first = openDb(path);
    assert.equal(first.markDelivered(SUB), true);
    first.close();
    const second = openDb(path);
    assert.equal(second.markDelivered(SUB), false);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
