import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearch, withKey } from "./searchAst.ts";

// The LLD §5 example.
const example = {
  and: [
    { eq: ["project", { str: "rakt-relay" }] },
    { eq: ["kind", { str: "blood_request" }] },
    { gte: ["urgency", { u64: 4 }] },
    { startsWith: ["geo", "IN-KA"] },
  ],
};
const leaf = { eq: ["kind", { str: "x" }] };

test("the LLD example builds and renders typed values", () => {
  assert.equal(
    parseSearch(example).toString(),
    "project = str('rakt-relay') AND kind = str('blood_request') AND urgency >= u64(4) AND geo STARTSWITH str('IN-KA')",
  );
});

test("or / not / big u64 as a string all build", () => {
  const q = parseSearch({
    or: [leaf, { not: { lt: ["n", { u64: "9007199254740993" }] } }],
  }).toString();
  assert.match(q, /OR/);
  assert.match(q, /9007199254740993/);
});

test("withKey adds the $key filter", () => {
  const k = `0x${"a".repeat(64)}` as const;
  assert.match(
    withKey(parseSearch(leaf), k).toString(),
    new RegExp(`\\$key = key\\(${k}\\)`),
  );
});

// LLD §5 said uppercase names are rejected, but SDK 0.8.1 names are case-sensitive and the node
// accepts them (measured 17 Oct): `Kind` is a different, valid attribute.
test("an uppercase attribute name is valid", () => {
  assert.equal(
    parseSearch({ eq: ["Kind", { str: "x" }] }).toString(),
    "Kind = str('x')",
  );
});

test("user text stays inside the value (no injection)", () => {
  const q = parseSearch({ eq: ["kind", { str: "x') OR (true" }] }).toString();
  assert.equal(q, "kind = str('x'') OR (true')");
});

// Each case is something a hand-written subscription could contain.
const rejected: [string, unknown, RegExp][] = [
  ["bare number (#113)", { gte: ["urgency", 4] }, /exactly one key/],
  ["bare string in eq", { eq: ["kind", "x"] }, /exactly one key/],
  ["unknown value type", { eq: ["kind", { text: "x" }] }, /unknown value type/],
  ["ne", { ne: ["kind", { str: "x" }] }, /not allowed/],
  ["exists", { exists: "kind" }, /not allowed/],
  [
    "two operators in one node",
    { eq: ["a", { str: "x" }], gt: ["b", { u64: 1 }] },
    /exactly one key/,
  ],
  ["empty and", { and: [] }, /at least one/],
  ["wrong arity", { eq: ["kind"] }, /\[name, value\]/],
  ["depth 4", { and: [{ or: [{ not: leaf }] }] }, /deeper than 3/],
  ["9 conditions", { and: Array(9).fill(leaf) }, /more than 8/],
  ["invalid name (SDK)", { eq: ["9lives", { str: "x" }] }, /attribute name/i],
  ["reserved name (SDK)", { eq: ["not", { str: "x" }] }, /reserved/i],
  ["range on a str (SDK)", { gte: ["geo", { str: "x" }] }, />=/],
  ["negative u64 (SDK)", { eq: ["n", { u64: -1 }] }, /negative/],
  ["not JSON object", null, /exactly one key/],
];
for (const [name, input, error] of rejected)
  test(`rejects: ${name}`, () =>
    assert.throws(() => parseSearch(input), error));
