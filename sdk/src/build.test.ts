import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { parseSearch } from "../../shared/searchAst.ts";
import type { Trigger } from "../../shared/schema.ts";
import {
  blocksOf,
  build,
  LIMITS,
  PrometheusError,
  whereToSearch,
  type Input,
} from "./build.ts";

const ME: Hex = `0x${"1".repeat(40)}`;
const TARGET = `0x${"b".repeat(64)}`;
const OWNER = "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B";

const fails = (f: () => unknown, code: string) =>
  assert.throws(f, (e) => e instanceof PrometheusError && e.code === code);

test("durations become 2-second blocks", () => {
  for (const [d, b] of [
    ["30s", 15n],
    ["10m", 300n],
    ["1h", 1_800n],
    ["1d", 43_200n],
    ["7d", 302_400n],
  ] as const)
    assert.equal(blocksOf(d, "for"), b, d);
});

test("anything else is a bad_duration", () => {
  for (const d of ["", "10", "1w", "1.5h", "-1m", "0m", "1s", "10 m", "1H"])
    fails(() => blocksOf(d, "for"), "bad_duration");
  for (const d of [10, 10n, undefined, null])
    fails(() => blocksOf(d, "for"), "bad_duration");
});

test("each trigger's draft is one the workers' decodeSubscription accepts", () => {
  const inputs: [Trigger, Input][] = [
    ["expiring", { target: TARGET, before: "1h", label: "a" }],
    ["expired", { target: TARGET, label: "a" }],
    ["changed", { target: TARGET, label: "a" }],
    [
      "keep",
      {
        target: TARGET,
        before: "10m",
        extendBy: "1d",
        label: "a",
        public: true,
      },
    ],
    ["new_match", { where: { kind: "booking" }, createdBy: OWNER, label: "a" }],
  ];
  for (const [trigger, input] of inputs)
    assert.doesNotThrow(() => build(trigger, input, ME), trigger);
});

test("params: typed attributes, a trimmed label, and `for` in blocks", () => {
  const { params, lead, term } = build(
    "keep",
    {
      target: TARGET,
      before: "10m",
      extendBy: "1d",
      for: "1h",
      label: " Ours ",
      public: true,
    },
    ME,
  );
  assert.equal(lead, 300n);
  assert.equal(term, 1_800n);
  assert.deepEqual(params.attributes, {
    project: "prometheus",
    kind: "subscription",
    trigger: "keep",
    target_key: { type: "key", value: TARGET },
    lead_blocks: { type: "u64", value: 300n },
    keep_blocks: { type: "u64", value: 43_200n },
  });
  assert.deepEqual(params.flags, { permissionlessExtension: true });
  assert.equal(params.expires.minLifetime, 1_800n);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(params.payload)), {
    v: 1,
    label: "Ours",
  });
  // `for` defaults to 7 days
  assert.equal(
    build("changed", { target: TARGET, label: "a" }, ME).term,
    302_400n,
  );
});

test("where → an equality search the worker's parser accepts", () => {
  const search = whereToSearch({
    kind: "booking",
    city: "Pune",
    seats: 4n,
    owner: OWNER,
    ref: TARGET,
  });
  assert.equal(
    parseSearch(search).toString(),
    `kind = str('booking') AND city = str('Pune') AND seats = u64(4) AND owner = addr(${OWNER}) AND ref = key(${TARGET})`,
  );
  const { params } = build(
    "new_match",
    { where: { kind: "x" }, createdBy: OWNER, label: "a" },
    ME,
  );
  assert.deepEqual(params.attributes?.target_owner, {
    type: "addr",
    value: OWNER,
  });
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(params.payload)).search,
    {
      and: [{ eq: ["kind", { str: "x" }] }],
    },
  );
});

test("bad where: empty, a bare number, too many conditions", () => {
  fails(() => whereToSearch({}), "bad_where");
  fails(() => whereToSearch(undefined), "bad_where");
  fails(() => whereToSearch({ seats: 4 }), "bad_where");
  const nine = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`a${i}`, "x"]),
  );
  fails(() => whereToSearch(nine), "bad_where");
  fails(
    () =>
      build(
        "new_match",
        { where: { k: "x" }, createdBy: "0x12", label: "a" },
        ME,
      ),
    "bad_created_by",
  );
});

test("bad input throws PrometheusError with the option's code, before anything is signed", () => {
  const exp = (o: Partial<Input>) => () =>
    build("expiring", { target: TARGET, before: "10m", label: "a", ...o }, ME);
  fails(exp({ label: "  " }), "bad_label");
  fails(exp({ label: "x".repeat(81) }), "bad_label");
  assert.doesNotThrow(exp({ label: "x".repeat(80) }));
  fails(exp({ before: "2d" }), "bad_before"); // lead too long
  fails(exp({ before: "30s" }), "bad_before"); // under a minute
  fails(exp({ target: "0x12" }), "bad_target");
  fails(exp({ before: "soon" as never }), "bad_duration");
  const keep = (before: string, extendBy: string) => () =>
    build(
      "keep",
      { target: TARGET, before, extendBy, label: "a" } as Input,
      ME,
    );
  fails(keep("2h", "2h"), "bad_extend_by"); // keep ≤ lead
  fails(keep("10m", "30m"), "bad_extend_by"); // under 1 hour
  fails(keep("10m", "31d"), "bad_extend_by");
  const err = (() => {
    try {
      exp({ label: "" })();
    } catch (e) {
      return e as PrometheusError;
    }
  })();
  assert.equal(
    err?.message,
    "Add a label. It's how you'll recognise the alert.",
  );
});

test("LIMITS are BOUNDS in the options' units", () => {
  assert.deepEqual(LIMITS, {
    labelMaxLength: 80,
    before: { min: "1m", max: "1d" },
    extendBy: { min: "1h", max: "30d" },
    subscriptionsPerWallet: 20,
    whereMaxConditions: 8,
  });
});
