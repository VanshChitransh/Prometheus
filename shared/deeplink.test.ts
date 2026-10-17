import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { decodeKey, encodeKey } from "./deeplink.ts";

const KEYS: Hex[] = [
  `0x${"0".repeat(64)}`,
  `0x${"f".repeat(64)}`,
  "0x6a693fd642c1f8f5e78321c2722208a3791ee79b0123456789abcdeffedcba98",
];

test("keys round-trip through a 43-char base64url payload", () => {
  for (const key of KEYS) {
    const payload = encodeKey(key);
    assert.match(payload, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(decodeKey(payload), key);
  }
});

test("uppercase hex decodes to the lowercase key", () => {
  const upper = `0x${"AB".repeat(32)}` as Hex;
  assert.equal(decodeKey(encodeKey(upper)), upper.toLowerCase());
});

test("decodeKey rejects wrong lengths, bad characters and raw hex", () => {
  const good = encodeKey(KEYS[2]!);
  for (const bad of [
    good.slice(0, 42), // 42 chars
    good + "A", // 44 chars
    "+" + good.slice(1), // standard base64, not base64url
    "/" + good.slice(1),
    good.slice(0, 42) + "=", // padding
    KEYS[2]!, // 0x hex
    "",
  ])
    assert.equal(decodeKey(bad), null, bad);
});

test("decodeKey rejects a non-canonical last character", () => {
  const good = encodeKey(KEYS[0]!); // ends in "A": the unused low bits are 0
  assert.equal(decodeKey(good.slice(0, 42) + "B"), null); // same bytes, unused bit set
});

test("encodeKey refuses anything but a 32-byte key", () => {
  assert.throws(() => encodeKey("0x1234"), /32-byte/);
});
