import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex, type Hex } from "viem";
import type { RawEntity } from "./arkiv.ts";
import { parseReceipt } from "./receipt.ts";

const A: Hex = "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B";
const B: Hex = "0xa70C8245582d173b04cAe453E9fF6D17a6e58294";
const STRANGER: Hex = `0x${"9".repeat(40)}`;
const TRUSTED = [A, B];
const SUB: Hex = `0x${"a".repeat(64)}`;
const TARGET: Hex = `0x${"c".repeat(64)}`;
const TRIGGER: Hex = `0x${"d".repeat(64)}`;

const receiptAttrs = (over: Record<string, unknown> = {}) => ({
  project: "prometheus",
  kind: "receipt",
  trigger_id: TRIGGER,
  subscription: SUB,
  subject: TARGET,
  event: "expired",
  trigger_block: 643_450n,
  ...over,
});

const raw = (
  creator: Hex,
  attributes: Record<string, unknown>,
  payload?: unknown,
): RawEntity => ({
  key: `0x${"1".repeat(64)}`,
  creator,
  owner: creator,
  createdAt: 1n,
  expiresAt: 999n,
  flags: { readonly: true, permissionlessExtension: false },
  attributes: attributes as RawEntity["attributes"],
  payload: payload === undefined ? undefined : toHex(JSON.stringify(payload)),
});

test("parseReceipt trusts only a worker-created prometheus receipt", () => {
  const r = parseReceipt(raw(A, receiptAttrs(), { v: 1 }), TRUSTED);
  assert.equal(r?.triggerId, TRIGGER);
  assert.equal(r?.triggerBlock, 643_450n);
  assert.equal(parseReceipt(raw(STRANGER, receiptAttrs()), TRUSTED), null);
  assert.equal(
    parseReceipt(raw(A, receiptAttrs({ kind: "worker" })), TRUSTED),
    null,
  );
  assert.equal(
    parseReceipt(raw(A, receiptAttrs({ project: "other" })), TRUSTED),
    null,
  );
  assert.equal(
    parseReceipt(raw(A, receiptAttrs({ trigger_block: "1" })), TRUSTED),
    null,
  );
});

test("parseReceipt refuses an unknown event and trusts addresses in any case", () => {
  // Every reader looks the event up in a table (the web's styles crashed on one it didn't know).
  assert.equal(
    parseReceipt(raw(A, receiptAttrs({ event: "bogus" })), TRUSTED),
    null,
  );
  const lower = TRUSTED.map((a) => a.toLowerCase() as Hex);
  assert.equal(parseReceipt(raw(A, receiptAttrs()), lower)?.creator, A);
});

test("parseReceipt reads the note and survives a broken payload", () => {
  const note = parseReceipt(
    raw(A, receiptAttrs({ event: "keep_skipped" }), {
      v: 1,
      note: "deny_listed",
    }),
    TRUSTED,
  );
  assert.equal(note?.note, "deny_listed");
  const broken = { ...raw(A, receiptAttrs()), payload: toHex("not json") };
  assert.equal(parseReceipt(broken, TRUSTED)?.note, undefined);
});

test("parseReceipt reads lateness, the writer and the target as the worker saw it", () => {
  const r = parseReceipt(
    raw(B, receiptAttrs({ done_block: 643_465n }), {
      v: 1,
      target_creator: A,
      target_owner: STRANGER,
    }),
    TRUSTED,
  );
  assert.equal(r?.creator, B);
  assert.equal(r?.doneBlock, 643_465n);
  assert.equal(r?.targetCreator, A);
  assert.equal(r?.targetOwner, STRANGER);
  assert.equal(
    parseReceipt(raw(A, receiptAttrs()), TRUSTED)?.doneBlock,
    undefined,
  );
});
