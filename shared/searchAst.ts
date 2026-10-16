// JSON search tree (stored in a new_match subscription's payload) → SDK query expression (LLD §5).
// Never a raw query string: user text only ever lands inside a typed value, so it can't change
// the query's shape. Browser-safe: the web form and the worker run the same checks.
//
// We check only what the SDK doesn't: allowed operators, typed values, and size.
// Attribute names, operator-vs-type rules and quote escaping are left to the SDK.
import {
  addr,
  bool,
  bytes32,
  i32,
  key,
  str,
  u64,
  type ArkivValue,
  type StrValue,
} from "@arkiv-network/sdk";
import {
  and,
  eq,
  gt,
  gte,
  lt,
  lte,
  not,
  or,
  startsWith,
  type Expression,
} from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { BOUNDS } from "./schema.ts";

const VALUES: Record<string, (v: never) => ArkivValue> = {
  str,
  u64,
  i32,
  addr,
  key,
  bytes32,
  bool,
};
const COMPARISONS = { eq, gt, gte, lt, lte };
// ne / exists / hasType are absent on purpose: the node refuses them.

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json =>
  typeof x === "object" && x !== null && !Array.isArray(x);

// The only node shape we accept: an object with exactly one key, e.g. { "eq": [...] }.
function single(x: unknown, what: string): [string, unknown] {
  const entries = isObject(x) ? Object.entries(x) : [];
  if (entries.length !== 1)
    throw new Error(
      `search: each ${what} must be an object with exactly one key`,
    );
  return entries[0]!;
}

// Values must name their type. A bare 4 would be coerced by the SDK to i32 and silently match
// nothing against a u64 attribute (issue #113), so we refuse it here.
function typed(v: unknown, name: string): ArkivValue {
  const [type, raw] = single(v, `value for "${name}" (e.g. { "u64": 4 })`);
  if (!Object.hasOwn(VALUES, type))
    throw new Error(`search: unknown value type "${type}" for "${name}"`);
  return VALUES[type]!(raw as never);
}

function args(x: unknown, op: string): [string, unknown] {
  if (!Array.isArray(x) || x.length !== 2)
    throw new Error(`search: ${op} takes [name, value]`);
  return [x[0], x[1]];
}

function build(node: unknown, depth: number, count: { n: number }): Expression {
  if (depth > BOUNDS.search.depth)
    throw new Error(`search: deeper than ${BOUNDS.search.depth} levels`);
  const [op, arg] = single(node, "node");

  if (op === "and" || op === "or") {
    if (!Array.isArray(arg)) throw new Error(`search: ${op} takes a list`);
    const children = arg.map((c) => build(c, depth + 1, count));
    return op === "and" ? and(children) : or(children); // the SDK rejects an empty list
  }
  if (op === "not") return not(build(arg, depth + 1, count));

  if (++count.n > BOUNDS.search.predicates)
    throw new Error(`search: more than ${BOUNDS.search.predicates} conditions`);
  if (op === "startsWith") {
    const [name, prefix] = args(arg, op);
    // Always a str, so a bare string is unambiguous here.
    return startsWith(
      name,
      typeof prefix === "string" ? prefix : (typed(prefix, name) as StrValue),
    );
  }
  if (Object.hasOwn(COMPARISONS, op)) {
    const [name, value] = args(arg, op);
    return COMPARISONS[op as keyof typeof COMPARISONS](
      name,
      typed(value, name),
    );
  }
  throw new Error(`search: operator "${op}" is not allowed`);
}

export const parseSearch = (json: unknown): Expression =>
  build(json, 1, { n: 0 });

// "Does this one entity match?": the search plus $key, sent to freeCount.
export const withKey = (expr: Expression, entityKey: Hex): Expression =>
  and(expr, eq("$key", key(entityKey)));
