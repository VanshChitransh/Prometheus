import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKey } from "../../shared/deeplink.ts";
import { launchPath, sponsorResult, tg } from "./telegram.ts";

const KEY = `0x${"ab".repeat(32)}` as const;

test("outside Telegram nothing is detected", () => {
  assert.equal(tg, undefined);
});

test("launch: Telegram's own hash is dropped, a startapp key opens its status page, startapp=new the form", () => {
  assert.equal(
    launchPath("/", "#tgWebAppData=query_id%3D1&tgWebAppVersion=9.1"),
    "/",
  );
  assert.equal(launchPath("/coverage", ""), "/coverage");
  assert.equal(launchPath("/docs/sdk", "#install"), "/docs/sdk#install");
  assert.equal(launchPath("/", "#tgWebAppData=x", encodeKey(KEY)), `/s/${KEY}`);
  assert.equal(launchPath("/", "#tgWebAppData=x", "not-a-key"), "/");
  assert.equal(launchPath("/", "#tgWebAppData=x", "new"), "/new");
});

test("launch: old #/ links land on their path", () => {
  assert.equal(launchPath("/", "#/coverage"), "/coverage");
  assert.equal(launchPath("/", `#/s/${KEY}`), `/s/${KEY}`);
});

test("sponsor replies: a tx is success, anything else shows the relay's own words", () => {
  const tx = `0x${"1".repeat(64)}`;
  assert.deepEqual(sponsorResult(200, { tx }), { ok: true, tx });
  assert.deepEqual(
    sponsorResult(409, { error: "You've already been sponsored." }),
    { ok: false, text: "You've already been sponsored." },
  );
  assert.deepEqual(sponsorResult(502, {}), {
    ok: false,
    text: "The relay couldn't send GLM (502).",
  });
  assert.equal(sponsorResult(200, { tx: "0xnope" }).ok, false);
});
