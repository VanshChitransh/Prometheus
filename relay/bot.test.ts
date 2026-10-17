import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import type { PublicArkivClient } from "@arkiv-network/sdk";
import type { UserFromGetMe } from "grammy/types";
import { toHex, type Hex } from "viem";
import { createBot } from "./bot.ts";
import { openDb } from "./db.ts";
import { encodeKey } from "../shared/deeplink.ts";

const TOKEN = "123456:SECRET-token_value";
const ME = {
  id: 1,
  is_bot: true,
  first_name: "Prometheus",
  username: "prometheus_arkiv_bot",
} as UserFromGetMe;
const k = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

// A live subscription as the node's raw arkiv_getEntity returns it.
const subRpc = (key: Hex, label: string) => ({
  key,
  creator: `0x${"9".repeat(40)}`,
  owner: `0x${"9".repeat(40)}`,
  createdAt: "0x1",
  expiresAt: "0x99999",
  attributes: [
    { name: "project", type: "string", value: "prometheus" },
    { name: "kind", type: "string", value: "subscription" },
    { name: "trigger", type: "string", value: "expired" },
    { name: "target_key", type: "string", value: k(999) },
  ],
  payload: toHex(JSON.stringify({ v: 1, label })),
});

// The node: every key in `subs` is a live subscription; tracks the most reads in flight at once.
function node(subs: Map<string, string>) {
  const reads = { inFlight: 0, max: 0 };
  const client = {
    request: async ({ params }: { params: [Hex] }) => {
      reads.max = Math.max(reads.max, ++reads.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      reads.inFlight--;
      const label = subs.get(params[0]);
      return label === undefined ? null : subRpc(params[0], label);
    },
  } as unknown as PublicArkivClient;
  return { client, reads };
}

// A local stand-in for api.telegram.org: records each call and answers like Telegram, including
// its 4096-character limit. Nothing here reaches Telegram.
async function fakeTelegram() {
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const method = req.url!.split("/").pop()!;
    const payload = body ? JSON.parse(body) : {};
    calls.push({ method, payload });
    const tooLong = method === "sendMessage" && payload.text.length > 4096;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        tooLong
          ? { ok: false, error_code: 400, description: "message is too long" }
          : { ok: true, result: { message_id: 1, date: 0, chat: { id: 7 } } },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

let updateId = 0;
// A private-chat command from user 7, through the same middleware polling uses.
const command = (text: string) => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: 7, type: "private" as const, first_name: "Ann" },
    from: { id: 7, is_bot: false, first_name: "Ann" },
    text,
    entities: [
      {
        type: "bot_command" as const,
        offset: 0,
        length: text.split(" ")[0]!.length,
      },
    ],
  },
});

test("a network error never carries the bot token: DMs, polling and replies", async () => {
  // Port 1 refuses the connection, as a Telegram outage would.
  const config = { botInfo: ME, client: { apiRoot: "http://127.0.0.1:1" } };
  const bot = createBot(
    TOKEN,
    openDb(":memory:"),
    node(new Map()).client,
    config,
  );
  const errors: unknown[] = [];
  await bot.api.sendMessage(1, "hi").catch((e) => errors.push(e)); // deliver.ts, index.ts
  await bot.api.getUpdates({ timeout: 0 }).catch((e) => errors.push(e)); // polling
  // ctx.reply: bot.ts logs err.error from the BotError.
  await bot.handleUpdate(command("/start")).catch((e) => errors.push(e.error));
  assert.equal(errors.length, 3);
  for (const e of errors) {
    assert.equal((e as Error).name, "HttpError"); // so grammY still retries polling
    const logged = inspect(e, { depth: 5 });
    assert.ok(!logged.includes(TOKEN), `token in: ${logged}`);
    assert.match(logged, /ECONNREFUSED/); // the reason survives
  }
});

test("messages go out without link previews unless the caller turns them on", async () => {
  const tg = await fakeTelegram();
  try {
    const subs = new Map([
      [k(1), "Phish: connect your wallet at evil.example"],
    ]);
    const config = { botInfo: ME, client: { apiRoot: tg.apiRoot } };
    const bot = createBot(TOKEN, openDb(":memory:"), node(subs).client, config);
    await bot.handleUpdate(command(`/start ${encodeKey(k(1))}`));
    await bot.api.sendMessage(7, "a DM");
    await bot.api.sendMessage(7, "asked for one", {
      link_preview_options: { is_disabled: false },
    });
    assert.deepEqual(
      tg.calls.map((c) => c.payload.link_preview_options?.is_disabled),
      [true, true, false],
    );
  } finally {
    await tg.close();
  }
});

test("a chat follows at most 40; /list of 40 longest labels fits one message, read 16 at a time", async () => {
  const tg = await fakeTelegram();
  try {
    // 41 live subscriptions, each with the longest label a worker accepts (80 characters).
    const subs = new Map(
      Array.from({ length: 41 }, (_, i) => [k(i + 1), "L".repeat(80)]),
    );
    const { client, reads } = node(subs);
    const db = openDb(":memory:");
    const config = { botInfo: ME, client: { apiRoot: tg.apiRoot } };
    const bot = createBot(TOKEN, db, client, config);
    const reply = async (text: string) => {
      await bot.handleUpdate(command(text));
      return tg.calls.at(-1)!.payload.text as string;
    };
    for (let i = 1; i <= 40; i++) await reply(`/start ${encodeKey(k(i))}`);
    assert.match(await reply(`/start ${encodeKey(k(41))}`), /follow 40/);
    assert.match(await reply(`/start ${encodeKey(k(40))}`), /Following/); // a repeat still works
    assert.equal(db.listFollows(7).length, 40);

    reads.max = 0;
    const list = await reply("/list");
    assert.match(list, /^40\. L{80} · /m);
    assert.ok(list.length <= 4096, `/list is ${list.length} characters`);
    assert.ok(reads.max <= 16, `${reads.max} label reads at once`);
  } finally {
    await tg.close();
  }
});
