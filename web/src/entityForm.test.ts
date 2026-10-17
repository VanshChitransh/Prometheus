import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawEntity } from "../../shared/arkiv.ts";
import { parseSearch } from "../../shared/searchAst.ts";
import { decodeSubscription } from "../../shared/subscription.ts";
import {
  searchRows,
  toDraft,
  toParams,
  toSearch,
  type FormValues,
} from "./entityForm.ts";

const TARGET = `0x${"b".repeat(64)}`;
const ME = `0x${"1".repeat(40)}` as const;
const form = (o: Partial<FormValues> = {}): FormValues => ({
  trigger: "expiring",
  targetKey: TARGET,
  leadMinutes: 10,
  keepHours: 24,
  termDays: 7,
  label: " Booking ",
  publicMonitor: false,
  ...o,
});
const decode = (o: Partial<FormValues>) =>
  decodeSubscription(toDraft(form(o), ME, 1_000n));

test("every P0 trigger's default form is a subscription the worker accepts", () => {
  for (const trigger of ["expiring", "expired", "changed", "keep"] as const)
    assert.equal(decode({ trigger }).ok, true, trigger);
});

test("units: minutes and hours become blocks; only the trigger's own fields are sent", () => {
  const keep = toDraft(form({ trigger: "keep" }), ME, 1_000n);
  assert.equal(keep.attributes.lead_blocks, 300n);
  assert.equal(keep.attributes.keep_blocks, 43_200n);
  assert.equal(keep.expiresAt, 1_000n + 7n * 43_200n);
  const expired = toDraft(form({ trigger: "expired" }), ME, 1_000n);
  assert.equal(expired.attributes.lead_blocks, undefined);
  assert.equal(expired.attributes.keep_blocks, undefined);
});

test("bad input is rejected with the worker's own reason", () => {
  const r = decode({ trigger: "keep", leadMinutes: 60, keepHours: 1 });
  assert.deepEqual(r, {
    ok: false,
    reason: "keep_blocks must be greater than lead_blocks",
  });
  assert.equal(decode({ leadMinutes: NaN }).ok, false);
  assert.equal(decode({ label: "  " }).ok, false);
  assert.equal(decode({ targetKey: "0x12" }).ok, false);
});

test("params carry the draft's values with their Arkiv types", () => {
  const d = toDraft(form({ trigger: "keep", publicMonitor: true }), ME, 1n);
  const p = toParams(d, 7);
  assert.deepEqual(p.attributes, {
    project: "prometheus",
    kind: "subscription",
    trigger: "keep",
    target_key: { type: "key", value: TARGET },
    lead_blocks: { type: "u64", value: 300n },
    keep_blocks: { type: "u64", value: 43_200n },
  });
  assert.deepEqual(p.flags, { permissionlessExtension: true });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(p.payload)), {
    v: 1,
    label: "Booking",
  });
});

// --- new_match (T4.3) ---

const OWNER = "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B";
const example: RawEntity = {
  key: `0x${"e".repeat(64)}`,
  creator: OWNER,
  owner: OWNER,
  createdAt: 1n,
  expiresAt: 99n,
  flags: { readonly: false, permissionlessExtension: false },
  attributes: {
    project: "rakt",
    kind: "blood_request",
    urgency: 4n,
    n: 2,
    big: "1",
  },
  types: { project: "str", kind: "str", urgency: "u64", n: "i32", big: "u256" },
};

test("searchRows: sorted, with the operators each type allows; u256 can't be searched", () => {
  assert.deepEqual(
    searchRows(example).map((r) => [r.name, r.type, r.value, r.ops.join(" ")]),
    [
      ["big", "u256", "1", ""],
      ["kind", "str", "blood_request", "eq startsWith"],
      ["n", "i32", "2", "eq gte lte gt lt"],
      ["project", "str", "rakt", "eq startsWith"],
      ["urgency", "u64", "4", "eq gte lte gt lt"],
    ],
  );
});

test("ticked rows build a typed search the worker accepts", () => {
  const search = toSearch([
    { name: "kind", type: "str", op: "eq", value: "blood_request" },
    { name: "urgency", type: "u64", op: "gte", value: " 4 " },
    { name: "n", type: "i32", op: "lt", value: "3" },
    { name: "project", type: "str", op: "startsWith", value: "ra" },
  ]);
  assert.equal(
    parseSearch(search).toString(),
    "kind = str('blood_request') AND urgency >= u64(4) AND n < i32(3) AND project STARTSWITH str('ra')",
  );
  const d = decode({ trigger: "new_match", search, targetOwner: OWNER });
  assert.equal(d.ok, true);
});

test("a new_match draft: no target_key or lead, owner as addr, search in the payload", () => {
  const search = toSearch([
    { name: "kind", type: "str", op: "eq", value: "x" },
  ]);
  const draft = toDraft(
    form({ trigger: "new_match", search, targetOwner: OWNER }),
    ME,
    1n,
  );
  assert.equal(draft.attributes.target_key, undefined);
  assert.equal(draft.attributes.lead_blocks, undefined);
  const p = toParams(draft, 7);
  assert.deepEqual(p.attributes?.target_owner, { type: "addr", value: OWNER });
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(p.payload)).search,
    search,
  );
  // Without the owner filter, no target_owner at all.
  const open = toDraft(form({ trigger: "new_match", search }), ME, 1n);
  assert.equal(open.attributes.target_owner, undefined);
});

test("bad searches fail with the worker's reason", () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({
    name: `a${i}`,
    type: "str",
    op: "eq",
    value: "x",
  }));
  const r = decode({ trigger: "new_match", search: toSearch(nine) });
  assert.deepEqual(r, { ok: false, reason: "search: more than 8 conditions" });
  for (const bad of [
    { name: "urgency", type: "u64", op: "eq", value: "high" },
    { name: "ok", type: "bool", op: "eq", value: "maybe" },
  ])
    assert.equal(
      decode({ trigger: "new_match", search: toSearch([bad]) }).ok,
      false,
    );
  assert.equal(decode({ trigger: "new_match" }).ok, false); // nothing ticked yet
});
