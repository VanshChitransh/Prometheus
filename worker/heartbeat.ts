// Keeps this worker's `worker` entity alive (LLD §2.1, §3.7). Expiry is the health check: each extend
// resets the entity to 30 minutes from now, so while the worker runs it never lapses, and if the
// worker dies it vanishes from Arkiv within 30 minutes. Node only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PublicArkivClient } from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/attr";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
import type { Hex } from "viem";
import { rawGetEntity } from "../shared/arkiv.ts";
import type { WorkerConfig } from "../shared/config.ts";
import { PROJECT, TRIGGERS } from "../shared/schema.ts";
import type { Writer } from "./writer.ts";

const LIFETIME = ExpirationTime.fromMinutes(30);
const EVERY_MS = 10 * 60_000; // 3 beats per lifetime: survives two missed beats
const FAILURES_BEFORE_ERROR = 3;

// Ensures the entity exists, then extends it every 10 minutes. Returns a function that stops the beats.
export async function startHeartbeat(
  writer: Writer,
  pub: PublicArkivClient,
  cfg: WorkerConfig,
  address: Hex,
) {
  // One file per wallet, so workers A and B can share a machine (and state/) while testing.
  const file = `state/worker-key-${address}.json`;

  const create = async (): Promise<Hex> => {
    const r = await writer.create({
      payload: jsonToPayload({
        name: "prometheus-worker",
        url: "",
        triggers: TRIGGERS,
      }),
      contentType: "application/json",
      attributes: {
        project: PROJECT,
        kind: "worker",
        version: "0.1.0",
        operator: cfg.delayBlocks === 0 ? "team-a" : "team-b", // a label only; trust is $creator
        delay_blocks: u64(cfg.delayBlocks),
      },
      expires: LIFETIME,
    });
    if (!r.ok) throw new Error(`worker entity create refused: ${r.reason}`);
    const key = r.value.entityKey;
    await mkdir("state", { recursive: true });
    await writeFile(file, JSON.stringify({ key }));
    console.log(
      `[heartbeat] worker entity live at ${new Date().toISOString()}: ${key} (owner ${address})`,
    );
    return key;
  };

  const saved = await loadKey(file);
  let key: Hex;
  if (saved && (await rawGetEntity(pub, saved))) {
    key = saved;
    console.log(`[heartbeat] reusing worker entity ${key}`);
  } else key = await create();

  let failures = 0;
  let stopped = false;
  let timer: NodeJS.Timeout;
  // setTimeout, not setInterval: the next beat is scheduled only after this one settles, so a slow
  // write can never overlap the next beat and create two entities.
  const beat = async () => {
    try {
      const r = await writer.extend({ entityKey: key, expires: LIFETIME });
      // Refused: start over only if it really lapsed (e.g. 30+ minutes of failed beats). Any other
      // refusal would otherwise leave two live worker entities for up to 30 minutes.
      if (!r.ok) {
        if (await rawGetEntity(pub, key))
          console.warn(
            `[heartbeat] extend refused (${r.errorName}); entity still live`,
          );
        else key = await create();
      }
      failures = 0;
    } catch (e) {
      failures++;
      const log =
        failures >= FAILURES_BEFORE_ERROR ? console.error : console.warn;
      log(`[heartbeat] beat failed (${failures} in a row)`, e);
    }
    if (!stopped) timer = setTimeout(beat, EVERY_MS);
  };
  timer = setTimeout(beat, EVERY_MS);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// The saved entity key; undefined on first boot.
async function loadKey(file: string): Promise<Hex | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")).key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e; // a corrupt file must be looked at, not silently replaced by a second entity
  }
}
