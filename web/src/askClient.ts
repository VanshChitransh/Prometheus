// The docs assistant's client (planning/PLAN/09 §5): POST the conversation to the relay's /ask and read
// its answer as it streams. The relay holds the API key; the browser never sees it.
declare const __RELAY_URL__: string; // vite.config.ts; "" = no relay, so no assistant

export type Turn = { role: "user" | "assistant"; content: string };

export const ASK_URL =
  typeof __RELAY_URL__ !== "undefined" && __RELAY_URL__
    ? `${__RELAY_URL__.replace(/\/$/, "")}/ask`
    : "";

export type SseEvent = { t: string } | { error: string } | "done";

// Complete `data: ...\n\n` events out of a buffer that may end mid-event; the rest waits for more bytes.
export function parseSse(buf: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let i: number;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 2);
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    events.push(data === "[DONE]" ? "done" : JSON.parse(data));
  }
  return { events, rest: buf };
}

// Yields the answer's text as it arrives. Throws the relay's own message (rate limit, cap, failure).
export async function* ask(
  turns: Turn[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const r = await fetch(ASK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: turns }),
    signal,
  });
  if (!r.ok || !r.body) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "The assistant is unavailable right now.");
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const parsed = parseSse(buf + value);
    buf = parsed.rest;
    for (const e of parsed.events) {
      if (e === "done") return;
      if ("error" in e) throw new Error(e.error);
      yield e.t;
    }
  }
}
