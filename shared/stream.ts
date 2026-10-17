// The ears of the worker and the relay (LLD §3.3 "Streams", §3.2 step 4, §6.4.7): live entity
// events and block heads over one WebSocket, and a buffered catch-up from the checkpoint whenever the
// feed may have a hole (start, a socket error, a stall), so neither a reconnect nor a restart leaves
// a gap. Node only.
import {
  decodeCreationFlags,
  ENTITY_EVENTS_ABI,
  type EntityEvent,
  type PublicArkivClient,
} from "@arkiv-network/sdk";
import type { publicWs } from "./arkiv.ts";
import { pastHead, replayEntityRanges, SeenLogs } from "./replay.ts";

// The system contract that emits every entity event. SDK 0.8.1 doesn't export its ARKIV_ADDRESS.
const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044";
const STALL_MS = 15_000; // ~7 missed 2 s blocks
const RETRY_MS = 5_000;
const HTTP_CATCHUP_TRIES = 10;

export type StreamOptions = {
  ws: Pick<
    ReturnType<typeof publicWs>,
    "watchEntityEvents" | "watchBlockNumber"
  >;
  http: Pick<PublicArkivClient, "getBlockNumber" | "getLogs">;
  checkpoint: () => bigint; // the last block fully handled; read at every (re)connect
  onEvent: (event: EntityEvent) => void;
  onHead: (head: bigint) => void; // only once caught up, so a checkpoint never skips unreplayed blocks
  // Every head, even while catching up: for work that only needs the clock (the receipt flush).
  // Withholding it stalled a buffering worker's flush, so its partner wrote duplicates (audit).
  onRawHead?: (head: bigint) => void;
};

// Starts listening and returns a function that stops it.
export function startStream({
  ws,
  http,
  checkpoint,
  onEvent,
  onHead,
  onRawHead,
}: StreamOptions) {
  const seen = new SeenLogs();
  let generation = 0; // bumped by every connect and by stop; an older catch-up seeing a newer one quits
  let buffer: EntityEvent[] | null = null; // null = live: events pass straight through
  let lastHead = 0n; // this generation's newest head
  let firstHead: PromiseWithResolvers<bigint> | undefined;
  let unwatch: (() => void)[] = [];
  let stallTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  // Seen only once handled: if onEvent throws, the catch-up that follows (via onError on the live
  // path, the replay's rejection on the other) must deliver it again, not skip it as seen.
  const deliver = (e: EntityEvent) => {
    if (!seen.add(e)) return;
    try {
      onEvent(e);
    } catch (err) {
      seen.forget(e);
      throw err;
    }
  };

  // Re-armed by every head; firing means the socket has gone quiet.
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      console.warn(
        `[stream] no head for ${STALL_MS / 1000}s: stall → resubscribe`,
      );
      void connect();
    }, STALL_MS);
  };

  // A socket error may have dropped events: viem 2.57.7 restores the subscriptions on reconnect but
  // never backfills the blocks in between (measured 16 Oct). Go back to buffering at once, so heads
  // stop advancing the checkpoint past the hole, and replay from it once the errors settle.
  const catchUpSoon = (why: string, e: unknown) => {
    generation++; // a catch-up already running must not go live over the hole
    buffer ??= [];
    console.error(
      `[stream] ${why}: ${String((e as Error)?.message ?? e).split("\n")[0]}; catch-up in ${RETRY_MS / 1000}s`,
    );
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), RETRY_MS);
  };

  const disconnect = () => {
    firstHead?.resolve(0n); // a connect still waiting for its first head is superseded: let it exit
    for (const u of unwatch) u();
    unwatch = [];
    clearTimeout(stallTimer);
    clearTimeout(retryTimer);
  };

  async function connect() {
    const gen = ++generation;
    disconnect();
    const box: EntityEvent[] = [];
    buffer = box;
    // Per generation: heads seen by a superseded subscription must not move the checkpoint past
    // what this generation replays (audit M8).
    lastHead = 0n;
    const first = Promise.withResolvers<bigint>();
    firstHead = first;
    try {
      // Subscribe first, then replay: a gap loses data, while an overlap is removed by `seen` (LLD §3.2).
      unwatch = [
        // No fromBlock: passing one switches viem to polling (LLD §3.3).
        ws.watchEntityEvents({
          onEvent: (e) => (buffer ? buffer.push(e) : deliver(e)),
          onError: (e) => catchUpSoon("events", e),
        }),
        ws.watchBlockNumber({
          onBlockNumber: (n) => {
            armStall();
            if (n > lastHead) lastHead = n;
            first.resolve(n);
            onRawHead?.(n);
            if (!buffer) onHead(n);
          },
          onError: (e) => catchUpSoon("heads", e),
        }),
      ];
      armStall();

      // viem sends eth_subscribe asynchronously, so "subscribed" isn't true yet when the calls above
      // return (audit H5). A head from this generation proves the socket's subscriptions are live
      // (logs subscribe before newHeads), so replay at least up to it: nothing in between is lost.
      const live = await first.promise;
      if (gen !== generation) return;
      const from = checkpoint() + 1n;
      let head = await http.getBlockNumber();
      for (let i = 0; head < live && i < HTTP_CATCHUP_TRIES; i++) {
        await new Promise((r) => setTimeout(r, 500)); // the HTTP node can trail the WS node briefly
        head = await http.getBlockNumber();
      }
      if (head < live)
        throw new Error(`HTTP head ${head} still behind the socket's ${live}`);
      // The caller owns the checkpoint, so only a restart (startBlock) can reset it (SH-5).
      if (pastHead(from - 1n, head))
        console.error(
          `[stream] checkpoint ${from - 1n} is past head ${head}: wipe? restart`,
        );
      await replayEntityRanges(
        from,
        head,
        (a, b) => entityLogs(http, a, b),
        (e) => {
          if (gen !== generation) throw new Error("superseded"); // stop fetching for a stale connect
          deliver(e);
        },
      );
      if (gen !== generation) return;
      for (const e of box) deliver(e);
      buffer = null;
      if (head > lastHead) lastHead = head;
      console.log(
        `[stream] replayed ${head >= from ? head - from + 1n : 0n} blocks (${from} → ${head}), live`,
      );
      onHead(lastHead);
    } catch (e) {
      if (gen !== generation) return;
      // Heads can keep arriving and re-arming the stall timer, so without this we'd buffer forever.
      catchUpSoon("catch-up failed", e);
    }
  }

  void connect();
  return () => {
    generation++;
    buffer = null;
    disconnect();
  };
}

// Entity events in [from, to], in the same shape watchEntityEvents delivers (mirrors the SDK's
// unexported toEntityEvent: context + decoded args, with creationFlags decoded).
async function entityLogs(
  http: StreamOptions["http"],
  from: bigint,
  to: bigint,
): Promise<EntityEvent[]> {
  const logs = await http.getLogs({
    address: ARKIV_ADDRESS,
    events: ENTITY_EVENTS_ABI,
    fromBlock: from,
    toBlock: to,
    strict: true,
  });
  return logs.map((log) => {
    const context = {
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    };
    return log.eventName === "EntityCreated"
      ? {
          type: log.eventName,
          ...context,
          ...log.args,
          creationFlags: decodeCreationFlags(log.args.creationFlags),
        }
      : ({ type: log.eventName, ...context, ...log.args } as EntityEvent);
  });
}
