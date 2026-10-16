// Catch-up after a dropped socket or a restart (LLD §3.2.4, §6.4.7): replay eth_getLogs from the
// checkpoint to head, skip logs already handled live, and persist progress. Node only.
// Modelled on the replay loop in Arkiv's official skills (realtime.md). Our own code: that repo
// ships no LICENSE file, so nothing is copied verbatim.
import { readFile, rename, writeFile } from "node:fs/promises";
import { rpcCode } from "./arkiv.ts";

const MAX_SPAN = 1_000n;

// The node rejects a too-wide eth_getLogs with -32602 (the text varies: "query exceeds max block
// range 100000" was measured in T0.3), or an oversized body with HTTP 413. Match codes, not text.
export const isLogCapacityError = (e: unknown) => {
  const code = rpcCode(e);
  return code === -32602 || code === 413;
};

export const smallerLogSpan = (span: bigint) => (span > 1n ? span / 2n : 1n);

// Calls onLog for every log in [from, to], in order, each block range fetched exactly once.
// ponytail: after a capacity error the span stays small for the rest of the replay; grow it back
// if replays over sparse ranges get slow.
export async function replayEntityRanges<L>(
  from: bigint,
  to: bigint,
  getLogs: (from: bigint, to: bigint) => Promise<L[]>,
  onLog: (log: L) => unknown,
  // A transient error retries the same chunk (1 s, 2 s, 4 s), not the whole replay: restarting an
  // hour-long replay from the checkpoint on every 429 might never finish (audit). Tests shrink it.
  { retries = 3, retryMs = 1_000 } = {},
): Promise<void> {
  let span = MAX_SPAN;
  for (let cursor = from, failures = 0; cursor <= to;) {
    const end = cursor + span - 1n < to ? cursor + span - 1n : to;
    let logs: L[];
    try {
      logs = await getLogs(cursor, end);
    } catch (e) {
      if (isLogCapacityError(e)) {
        // Halve and retry the same cursor; at span 1 there is nothing left to shrink.
        if (span > 1n) {
          span = smallerLogSpan(span);
          continue;
        }
        throw new Error(
          `block ${cursor} alone exceeds the node's log capacity`,
          { cause: e },
        );
      }
      if (failures >= retries) throw e;
      await new Promise((r) => setTimeout(r, retryMs * 2 ** failures++));
      continue;
    }
    failures = 0;
    for (const log of logs) await onLog(log);
    cursor = end + 1n;
  }
}

// Logs seen live or in a replay, keyed txHash:logIndex (one key per event, even when a tx touches
// the same entity twice). Bounded: a Set keeps insertion order, so the oldest key is evicted first.
export class SeenLogs {
  readonly #keys = new Set<string>();
  readonly #max: number;
  constructor(max = 10_000) {
    this.#max = max;
  }
  // true the first time a log is seen; false for a repeat.
  add(log: { transactionHash: string; logIndex: number | bigint }): boolean {
    const k = `${log.transactionHash}:${log.logIndex}`;
    if (this.#keys.has(k)) return false;
    this.#keys.add(k);
    if (this.#keys.size > this.#max)
      this.#keys.delete(this.#keys.values().next().value!);
    return true;
  }
}

// The last block fully handled. undefined = no checkpoint yet (first boot).
export async function loadCheckpoint(
  path: string,
): Promise<bigint | undefined> {
  try {
    return BigInt(JSON.parse(await readFile(path, "utf8")).block);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e; // a corrupt file must be looked at, not silently replaced by "start from scratch"
  }
}

// Atomic: rename replaces the file in one step, so a crash leaves the old or the new checkpoint,
// never half of one.
export async function saveCheckpoint(path: string, block: bigint) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify({ block: String(block) }));
  await rename(tmp, path);
}
