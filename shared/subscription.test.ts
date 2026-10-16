import { test } from "node:test";
import assert from "node:assert/strict";
import { toHex } from "viem";
import type { RawEntity } from "./arkiv.ts";
import { decodeSubscription } from "./subscription.ts";

const TARGET = `0x${"b".repeat(64)}`;
const search = { eq: ["kind", { str: "blood_request" }] };

// A raw entity as rawGetEntity returns it; `attrs` override the defaults, undefined removes one.
const entity = (
  attrs: Record<string, unknown>,
  payload: unknown = { v: 1, label: "Lapse canary" },
): RawEntity => {
  const attributes = { project: "prometheus", kind: "subscription", ...attrs };
  for (const k in attributes)
    if (attributes[k as keyof typeof attributes] === undefined)
      delete attributes[k as keyof typeof attributes];
  return {
    key: `0x${"a".repeat(64)}`,
    creator: `0x${"1".repeat(40)}`,
    owner: `0x${"1".repeat(40)}`,
    createdAt: 650_000n,
    expiresAt: 900_000n,
    flags: { readonly: false, permissionlessExtension: true },
    attributes: attributes as RawEntity["attributes"],
    payload:
      typeof payload === "string"
        ? toHex(payload)
        : toHex(JSON.stringify(payload)),
  };
};

const valid: Record<string, RawEntity> = {
  expiring: entity({
    trigger: "expiring",
    target_key: TARGET,
    lead_blocks: 60n,
  }),
  expired: entity({ trigger: "expired", target_key: TARGET }),
  changed: entity({ trigger: "changed", target_key: TARGET }),
  keep: entity({
    trigger: "keep",
    target_key: TARGET,
    lead_blocks: 60n,
    keep_blocks: 2_000n,
  }),
  new_match: entity(
    { trigger: "new_match" },
    { v: 1, label: "Urgent", search },
  ),
};

for (const [trigger, e] of Object.entries(valid))
  test(`valid ${trigger} decodes`, () => {
    const r = decodeSubscription(e);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    assert.equal(r.sub.trigger, trigger);
    assert.equal(r.sub.maxPerDay, 20); // default when the attribute is missing
    assert.equal(r.sub.publicMonitor, true);
  });

test("new_match keeps the parsed search and a checksummed target_owner", () => {
  const r = decodeSubscription(
    entity(
      {
        trigger: "new_match",
        target_owner: "0x6a693fd642c1f8f5e78321c2722208a3791ee79b",
      },
      { v: 1, label: "x", search },
    ),
  );
  assert.ok(r.ok);
  assert.equal(r.sub.search!.toString(), "kind = str('blood_request')");
  assert.equal(r.sub.targetOwner, "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B");
});

const expiring = { trigger: "expiring", target_key: TARGET, lead_blocks: 60n };
const keep = {
  trigger: "keep",
  target_key: TARGET,
  lead_blocks: 60n,
  keep_blocks: 2_000n,
};
// One rejection per rule: [name, entity, expected reason].
const rejected: [string, RawEntity, RegExp][] = [
  [
    "another project",
    entity({ ...expiring, project: "other" }),
    /not a prometheus/,
  ],
  [
    "another kind",
    entity({ ...expiring, kind: "receipt" }),
    /not a prometheus/,
  ],
  [
    "unknown trigger",
    entity({ ...expiring, trigger: "banana" }),
    /trigger must be/,
  ],
  [
    "missing target_key",
    entity({ ...expiring, target_key: undefined }),
    /target_key/,
  ],
  [
    "malformed target_key",
    entity({ ...expiring, target_key: "0x12" }),
    /target_key/,
  ],
  [
    "missing lead_blocks",
    entity({ ...expiring, lead_blocks: undefined }),
    /lead_blocks is required/,
  ],
  [
    "lead_blocks 29",
    entity({ ...expiring, lead_blocks: 29n }),
    /lead_blocks must be 30/,
  ],
  [
    "lead_blocks 43,201",
    entity({ ...expiring, lead_blocks: 43_201n }),
    /lead_blocks must be/,
  ],
  [
    "lead_blocks as i32",
    entity({ ...expiring, lead_blocks: 60 }),
    /must be a u64/,
  ],
  [
    "missing keep_blocks",
    entity({ ...keep, keep_blocks: undefined }),
    /keep_blocks is required/,
  ],
  [
    "keep_blocks = lead",
    entity({ ...keep, keep_blocks: 60n }),
    /greater than lead_blocks/,
  ],
  [
    "keep_blocks < lead",
    entity({ ...keep, keep_blocks: 30n }),
    /greater than lead_blocks/,
  ],
  [
    "keep_blocks < 1 hour",
    entity({ ...keep, keep_blocks: 1_799n }),
    /at least 1,800 \(1 hour\)/,
  ],
  [
    "keep_blocks > 30 days",
    entity({ ...keep, keep_blocks: 1_296_001n }),
    /at most 30 days/,
  ],
  ["max_per_day 0", entity({ ...expiring, max_per_day: 0n }), /max_per_day/],
  [
    "max_per_day 101",
    entity({ ...expiring, max_per_day: 101n }),
    /max_per_day/,
  ],
  [
    "bad target_owner",
    entity(
      { trigger: "new_match", target_owner: "x" },
      { v: 1, label: "x", search },
    ),
    /target_owner/,
  ],
  ["payload not JSON", entity(expiring, "not json"), /payload must be JSON/],
  ["payload v: 2", entity(expiring, { v: 2, label: "x" }), /v: 1/],
  ["empty label", entity(expiring, { v: 1, label: "  " }), /label is required/],
  ["new_match without search", entity({ trigger: "new_match" }), /search/],
  [
    "search with a bare number",
    entity(
      { trigger: "new_match" },
      { v: 1, label: "x", search: { gte: ["urgency", 4] } },
    ),
    /search/,
  ],
];
for (const [name, e, reason] of rejected)
  test(`rejects: ${name}`, () => {
    const r = decodeSubscription(e);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, reason);
  });
