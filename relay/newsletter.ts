// POST /subscribe: an email for the newsletter, kept in the relay's SQLite file and never on Arkiv
// (everything there is public). Valid or repeat, the reply is the same, so nobody can probe who
// subscribed. Each IP gets `perIp` tries per window, and `max` bounds the table if someone floods it.
import type { Db } from "./db.ts";

export type SubscribeReply = { status: number; body: unknown };

// Enough to catch typos; the real check is whether mail arrives.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createSubscribe(o: {
  db: Pick<Db, "addSubscriber" | "subscriberCount">;
  perIp?: number;
  windowMs?: number;
  max?: number;
  now?: () => number;
}) {
  const { db, perIp = 5, windowMs = 10 * 60_000, max = 10_000 } = o;
  const now = o.now ?? Date.now;
  const recent = new Map<string, number[]>(); // ip → attempt times inside the window

  return (body: unknown, ip: string): SubscribeReply => {
    const t = now();
    const mine = (recent.get(ip) ?? []).filter((at) => t - at < windowMs);
    if (mine.length >= perIp)
      return {
        status: 429,
        body: { error: "Too many tries. Try again in a few minutes." },
      };
    recent.set(ip, [...mine, t]);

    const email = (body as { email?: unknown } | null)?.email;
    if (
      typeof email !== "string" ||
      email.length > 254 ||
      !EMAIL.test(email.trim())
    )
      return {
        status: 400,
        body: { error: "That doesn't look like an email address." },
      };
    if (db.subscriberCount() >= max)
      return { status: 503, body: { error: "Sign-ups are closed for now." } };
    db.addSubscriber(email.trim());
    return { status: 200, body: { ok: true } };
  };
}
