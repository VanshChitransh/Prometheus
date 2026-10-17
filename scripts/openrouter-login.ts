// Gets an OpenRouter key for the docs assistant (relay/ask.ts) from the terminal: OpenRouter's PKCE login
// (openrouter.ai/docs/use-cases/oauth-pkce). Opens the browser to sign in and approve, catches the code on
// a localhost callback, swaps it for a key, writes OPENROUTER_API_KEY into the env file and tests one free
// model. The key is never printed.
// Run: npm run openrouter:login            (writes .env.relay)
//      npm run openrouter:login -- .env    (another env file)
import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FREE_MODELS } from "../relay/ask.ts";

const file = process.argv[2] ?? ".env.relay";
const b64url = (b: Buffer) => b.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16)); // the callback must echo it, so another page can't inject a code

// 1. Wait for OpenRouter to redirect the browser back with ?code=…
const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/callback") return res.writeHead(404).end();
    const ok =
      url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" });
    res.end(
      ok
        ? "Done. Back to the terminal."
        : "Login failed. Run the script again.",
    );
    server.close();
    ok
      ? resolve(ok)
      : reject(new Error("callback had no code, or the wrong state"));
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    const auth = new URL("https://openrouter.ai/auth");
    auth.search = new URLSearchParams({
      callback_url: `http://localhost:${port}/callback`,
      code_challenge: challenge,
      code_challenge_method: "S256",
      key_label: "Prometheus docs assistant",
      state,
    }).toString();
    console.log(
      `Opening your browser to sign in to OpenRouter. If it doesn't open:\n${auth}\n`,
    );
    exec(`${process.platform === "darwin" ? "open" : "xdg-open"} "${auth}"`);
  });
  setTimeout(
    () => reject(new Error("no login within 5 minutes")),
    300_000,
  ).unref();
});

// 2. Swap the one-time code (valid 10 min) for a key.
const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    code,
    code_verifier: verifier,
    code_challenge_method: "S256",
  }),
});
const { key } = (await res.json().catch(() => ({}))) as { key?: string };
if (!res.ok || !key) throw new Error(`key exchange failed: HTTP ${res.status}`);

// 3. Into the env file: replace an existing line or append one. Owner-only, like the other .env files.
const env = existsSync(file) ? readFileSync(file, "utf8") : "";
const line = `OPENROUTER_API_KEY=${key}`;
writeFileSync(
  file,
  /^OPENROUTER_API_KEY=.*$/m.test(env)
    ? env.replace(/^OPENROUTER_API_KEY=.*$/m, line)
    : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`,
);
chmodSync(file, 0o600);
console.log(`Saved OPENROUTER_API_KEY to ${file} (sk-or-…${key.slice(-4)}).`);

// 4. One tiny request through the same model list the relay uses.
const test = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    models: FREE_MODELS,
    max_tokens: 20,
    messages: [{ role: "user", content: "Reply with the word: ready" }],
  }),
});
const body = (await test.json().catch(() => ({}))) as {
  model?: string;
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
};
if (test.ok && body.choices?.length)
  console.log(
    `Test OK: ${body.model} answered "${body.choices[0]!.message?.content?.trim()}".`,
  );
else {
  console.log(
    `Test failed (HTTP ${test.status}): ${body.error?.message ?? "no answer"}`,
  );
  if (/data policy/i.test(body.error?.message ?? ""))
    console.log(
      "Allow free endpoints at https://openrouter.ai/settings/privacy, then run it again.",
    );
  process.exitCode = 1;
}
