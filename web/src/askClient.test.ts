import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse } from "./askClient.ts";

test("parseSse keeps a half-received event for the next chunk", () => {
  const a = parseSse('data: {"t":"Hel"}\n\ndata: {"t":"l');
  assert.deepEqual(a.events, [{ t: "Hel" }]);
  const b = parseSse(`${a.rest}o"}\n\ndata: [DONE]\n\n`);
  assert.deepEqual(b.events, [{ t: "lo" }, "done"]);
  assert.equal(b.rest, "");
  assert.deepEqual(parseSse('data: {"error":"x"}\n\n').events, [
    { error: "x" },
  ]);
});
