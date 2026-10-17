---
title: Use Prometheus from an AI coding agent
description: How to get Claude Code, Codex or Cursor to add a correct Prometheus subscription to your app.
status: live
---

A coding agent can add Prometheus to your app in a few lines, because the [SDK](./sdk.md) does the hard part: it builds the subscription, checks it against the workers' own rules and refuses to sign anything they would skip. This page gives you a prompt and an `AGENTS.md` block to paste.

## What to give your agent

1. **The docs.** `<site>/llms.txt` lists every docs page in a form agents read well. `<site>/llms-full.txt` is all of them in one file.
2. **A precise prompt.** Use the one below.
3. **The rules, once.** Paste the `AGENTS.md` block below into your repo, so every future session follows them.

## A prompt you can paste

Replace the parts in angle brackets.

```text
Read <site>/llms.txt.

Then add a Prometheus watch to this app with the prometheus-arkiv SDK:
- warn me 1 hour before the Arkiv entity <entity key> expires
- label it "<label>"
- the subscription runs for 7 days

Sign with the user's own wallet client. Never hard-code or generate a private key.
Print the subscription key and its telegramUrl so I can follow it in Telegram.
```

To ask for something else, change the first bullet: "tell me when it has expired", "tell me when it changes", "keep it alive, renewing 10 minutes before it expires and adding a day each time", or "tell me about new entities where kind is booking and city is Pune".

## An AGENTS.md block

Paste this into `AGENTS.md` at the root of your repo. If your agent reads a different file, such as `CLAUDE.md` for Claude Code, paste it there.

```markdown
## Prometheus (alerts for Arkiv entities)

Prometheus watches Arkiv entities and sends Telegram alerts. Use the prometheus-arkiv SDK.
Docs: <site>/llms.txt

- Install: npm i prometheus-arkiv @arkiv-network/sdk viem
- Create: const prometheus = new Prometheus({ wallet }), where wallet is the user's own
  @arkiv-network/sdk wallet client. Never hard-code, log or generate a private key.
- Watch: prometheus.watch.expiring(key, { before, label }), .expired(key, { label }),
  .changed(key, { label }), .keep(key, { before, extendBy, label }),
  .newMatch({ where, label }). Optional on all: for (default "7d"), public.
- Durations are strings: "30s", "10m", "1h", "7d". before: 1m to 1d. extendBy: 1h to 30d and
  more than before.
- Every watch call checks first and throws PrometheusError (with a code) instead of signing
  something workers would skip. Show e.message to the user; don't retry blindly.
- Validate without signing: prometheus.check.<trigger>(same arguments).
- Keep the returned key: renew(key, "30d"), cancel(key), get(key), receipts(key).
- Give the user result.telegramUrl to follow the alert in Telegram.
- Never use keep for a canary or heartbeat: their expiry is the signal, and workers refuse them.
- A wallet's oldest 20 live subscriptions are served; check before creating more.
```

## Check the agent's work

Before you let the agent sign anything, read what it wrote:

- Does it pass the user's wallet client, not a key it made up or pasted into the code?
- Does it catch `PrometheusError` and show the message?
- For `keep`, is the target something that should live on, not a canary or heartbeat?

After it runs, open `<site>/#/s/<subscription key>` to see the subscription the way workers read it.

## Coming soon

These aren't available yet. Don't run them.

- **A setup command** (`npx prometheus-arkiv init`) that adds the `AGENTS.md` block for you.
- **An MCP server**, so an agent could create and check subscriptions as tools.

## Next

- [The Prometheus SDK](./sdk.md): every method, with examples and error codes.
- [Triggers](./triggers.md): when each trigger fires, and its edge cases.
- [Limits](./limits.md): every number workers enforce.
