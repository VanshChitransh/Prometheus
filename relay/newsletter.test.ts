import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createSubscribe } from "./newsletter.ts";

test("subscribe: stores once, case-blind, same reply for a repeat", () => {
  const db = openDb(":memory:");
  const sub = createSubscribe({ db });
  assert.deepEqual(sub({ email: " You@Example.com " }, "1"), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual(sub({ email: "you@example.com" }, "2"), {
    status: 200,
    body: { ok: true },
  });
  assert.equal(db.subscriberCount(), 1);
});

test("subscribe: refuses junk, floods from one IP, and a full list", () => {
  const db = openDb(":memory:");
  let t = 0;
  const sub = createSubscribe({
    db,
    perIp: 2,
    windowMs: 1000,
    max: 2,
    now: () => t,
  });
  for (const bad of [
    null,
    {},
    { email: 5 },
    { email: "nope" },
    { email: "a@b" },
    { email: `${"a".repeat(250)}@b.co` },
  ])
    assert.equal(sub(bad, `junk-${JSON.stringify(bad)}`).status, 400);
  assert.equal(sub({ email: "a@x.co" }, "ip").status, 200);
  assert.equal(sub({ email: "b@x.co" }, "ip").status, 200);
  assert.equal(sub({ email: "c@x.co" }, "ip").status, 429); // third try inside the window
  t = 1000;
  assert.equal(sub({ email: "c@x.co" }, "ip").status, 503); // window passed, but the list is full
});
