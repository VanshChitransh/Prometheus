// The relay's only persistent state (LLD §6.1): who follows what, which triggers were already DM'd,
// and who was sponsored. Every "only once" rule is a table constraint, so it survives restarts and
// a single INSERT OR IGNORE answers "was I first?" with no check-then-insert race.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY = 86_400; // seconds; created_at is unix seconds

// Exactly the LLD §6.1 DDL, plus IF NOT EXISTS so reopening an existing file is a no-op.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS follows  (chat_id INTEGER, sub_key TEXT, created_at INTEGER,
                                     PRIMARY KEY (chat_id, sub_key));
CREATE TABLE IF NOT EXISTS sponsors (tg_user_id INTEGER PRIMARY KEY, address TEXT UNIQUE,
                                     amount_wei TEXT, tx TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS delivered (trigger_id TEXT PRIMARY KEY, created_at INTEGER);
`;

export type Db = ReturnType<typeof openDb>;

// `now` returns milliseconds like Date.now; tests pass a fake clock.
// Keys and addresses are lowercased here, not by callers: UNIQUE compares exact text, so
// 0xAbC… and 0xabc… would otherwise count as two wallets.
export function openDb(path: string, now: () => number = Date.now) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true }); // SQLite won't create it
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const sec = () => Math.floor(now() / 1000);

  const insFollow = db.prepare(
    "INSERT OR IGNORE INTO follows (chat_id, sub_key, created_at) VALUES (?, ?, ?)",
  );
  const delFollow = db.prepare(
    "DELETE FROM follows WHERE chat_id = ? AND sub_key = ?",
  );
  // sub_key breaks same-second ties, so `/stop n` always means the n-th line `/list` showed.
  const selFollows = db.prepare(
    "SELECT sub_key FROM follows WHERE chat_id = ? ORDER BY created_at, sub_key",
  );
  const selChats = db.prepare("SELECT chat_id FROM follows WHERE sub_key = ?");
  const insDelivered = db.prepare(
    "INSERT OR IGNORE INTO delivered (trigger_id, created_at) VALUES (?, ?)",
  );
  const delDelivered = db.prepare("DELETE FROM delivered WHERE created_at < ?");
  // Ignored on either conflict: the same Telegram user (PRIMARY KEY) or the same address (UNIQUE).
  const insSponsor = db.prepare(
    "INSERT OR IGNORE INTO sponsors (tg_user_id, address, amount_wei, created_at) VALUES (?, ?, ?, ?)",
  );
  const selSponsored = db.prepare(
    "SELECT amount_wei FROM sponsors WHERE created_at >= ?",
  );

  return {
    follow(chatId: number, subKey: string) {
      insFollow.run(chatId, subKey.toLowerCase(), sec());
    },
    // True if the follow existed.
    unfollow(chatId: number, subKey: string): boolean {
      return Number(delFollow.run(chatId, subKey.toLowerCase()).changes) > 0;
    },
    listFollows(chatId: number): string[] {
      return selFollows.all(chatId).map((r) => r.sub_key as string);
    },
    chatsFor(subKey: string): number[] {
      return selChats.all(subKey.toLowerCase()).map((r) => r.chat_id as number);
    },
    // True only the first time an id is seen: the caller sends the DM only then.
    markDelivered(triggerId: string): boolean {
      return (
        Number(insDelivered.run(triggerId.toLowerCase(), sec()).changes) === 1
      );
    },
    // Returns the number of rows deleted.
    pruneDelivered(): number {
      return Number(delDelivered.run(sec() - 30 * DAY).changes);
    },
    // Call BEFORE sending GLM: false means this user or address was already sponsored.
    claimSponsor(
      tgUserId: number,
      address: string,
      amountWei: bigint,
    ): boolean {
      const r = insSponsor.run(
        tgUserId,
        address.toLowerCase(),
        amountWei.toString(),
        sec(),
      );
      return Number(r.changes) === 1;
    },
    // Summed as BigInt: SQL SUM() would turn the TEXT wei into a lossy float.
    sponsoredLast24h(): bigint {
      return selSponsored
        .all(sec() - DAY)
        .reduce((sum, r) => sum + BigInt(r.amount_wei as string), 0n);
    },
    close() {
      db.close();
    },
  };
}
