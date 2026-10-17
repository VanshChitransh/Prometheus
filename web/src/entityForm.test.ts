import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSubscription } from "../../shared/subscription.ts";
import { toDraft, toParams, type FormValues } from "./entityForm.ts";

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
