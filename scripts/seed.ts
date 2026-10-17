// Recreates the demo in one command, including after a testnet wipe (T5.1, LLD §9).
// Run: npm run seed   (needs the running workers to see anything fire; costs a few txs of GLM)
// The publisher creates short-lived targets; the subscriber watches them. Within ~10 min a worker
// writes `warned` then `expired` receipts for demo-booking-1.
import { key, u64 } from "@arkiv-network/sdk/attr";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
import { formatEther, type Hex } from "viem";
import {
  freeCount,
  publicHttp,
  rawGetEntity,
  walletClient,
} from "../shared/arkiv.ts";
import { encodeKey } from "../shared/deeplink.ts";
import { BOUNDS, PROJECT, type Trigger } from "../shared/schema.ts";
import { decodeSubscription, type Decoded } from "../shared/subscription.ts";

const env = (name: string, rule: RegExp) => {
  const v = process.env[name]?.trim();
  if (!v || !rule.test(v)) {
    console.error(`[seed] ${name} is missing or malformed (see .env.example)`);
    process.exit(1);
  }
  return v;
};
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const http = env("ARKIV_HTTP", /^https:\/\//);
const accessKey = process.env.ARKIV_ACCESS_KEY?.trim() || undefined;
const pub = publicHttp(http, accessKey);
const publisher = walletClient(
  env("DEMO_PUBLISHER_PRIVATE_KEY", PRIVATE_KEY) as Hex,
  http,
  accessKey,
);
const subscriber = walletClient(
  env("DEMO_SUBSCRIBER_PRIVATE_KEY", PRIVATE_KEY) as Hex,
  http,
  accessKey,
);

// Fail before the first write, not halfway through with half a demo on chain.
for (const w of [publisher, subscriber]) {
  const address = w.account.address;
  const balance = await pub.getBalance({ address });
  if (balance === 0n) {
    console.error(`[seed] ${address} has no GLM; fund it and rerun`);
    process.exit(1);
  }
  console.log(`[seed] ${address} ${formatEther(balance)} GLM`);
}

// Not PROJECT: the keeper deny-lists our own entities, which would turn every keep into a skip.
const TARGET_PROJECT = `${PROJECT}-demo`;

// Writes are awaited one by one: each waits for its receipt, so a wallet's nonces never race.
async function target(
  name: string,
  kind: string,
  minutes: number,
  permissionlessExtension = false,
) {
  const { entityKey } = await publisher.createEntity({
    payload: jsonToPayload({ name }),
    contentType: "application/json",
    attributes: { project: TARGET_PROJECT, kind, name },
    flags: { permissionlessExtension },
    expires: ExpirationTime.fromMinutes(minutes),
  });
  console.log(`[seed] target ${name} (${minutes} min) ${entityKey}`);
  return entityKey;
}

// 2 h, not the web form's 1-day minimum: the worker ignores a creator's subscriptions beyond 20, so
// day-long demo ones would block the 4th seed run of a day (T5.4 reruns it).
const SUB_LIFETIME = ExpirationTime.fromHours(2);

const subs: { label: string; key: Hex }[] = [];
async function subscribe(
  label: string,
  trigger: Trigger,
  targetKey: Hex,
  blocks: { lead?: number; keep?: number } = {},
) {
  const { entityKey } = await subscriber.createEntity({
    payload: jsonToPayload({ v: 1, label }),
    contentType: "application/json",
    attributes: {
      project: PROJECT,
      kind: "subscription",
      trigger,
      target_key: key(targetKey),
      ...(blocks.lead !== undefined && { lead_blocks: u64(blocks.lead) }),
      ...(blocks.keep !== undefined && { keep_blocks: u64(blocks.keep) }),
    },
    expires: SUB_LIFETIME,
  });
  subs.push({ label, key: entityKey });
}

// Targets first: every subscription needs its target's key.
const canary = await target("demo-canary", "canary", 15);
const bookings = [
  await target("demo-booking-1", "booking", 10),
  await target("demo-booking-2", "booking", 20),
  await target("demo-booking-3", "booking", 30),
];
// P1: renewable by anyone. The community record gets kept; the heartbeat is deny-listed by kind.
const community = await target("demo-community", "record", 30, true);
const heartbeat = await target("demo-heartbeat", "heartbeat", 30, true);

// lead 150 blocks = 5 min before expiry. booking-1 alone yields warned (~5 min) and expired (~10 min).
await subscribe("Canary expired", "expired", canary);
await subscribe("Booking 1 expiring", "expiring", bookings[0], { lead: 150 });
await subscribe("Booking 1 expired", "expired", bookings[0]);
await subscribe("Booking 2 expiring", "expiring", bookings[1], { lead: 150 });
await subscribe("Booking 3 expiring", "expiring", bookings[2], { lead: 150 });
// Keeps fire at lead 300 = 10 min before expiry and add 1,800 blocks (1 h, the minimum).
const keep = { lead: 300, keep: 1_800 };
await subscribe("Keep canary (refused)", "keep", canary, keep); // not_permissionless
await subscribe("Keep heartbeat (refused)", "keep", heartbeat, keep); // deny_listed
await subscribe("Keep community record", "keep", community, keep); // kept

// Read each one back as the worker will (free reads): a rejected subscription would never fire.
let rejected = 0;
for (const s of subs) {
  const e = await rawGetEntity(pub, s.key);
  const d: Decoded = e
    ? decodeSubscription(e)
    : { ok: false, reason: "not found" };
  if (!d.ok) {
    rejected++;
    console.error(`[seed] ${s.label} ${s.key} rejected: ${d.reason}`);
  }
}

// Earlier runs' subscriptions still count toward the subscriber's cap; the worker drops the newest.
const live = await freeCount(
  pub,
  `project = str('${PROJECT}') AND kind = str('subscription') AND $creator = addr(${subscriber.account.address})`,
);
const over = Math.min(live - BOUNDS.subsPerCreator, subs.length);
if (over > 0) {
  rejected += over;
  console.error(
    `[seed] the subscriber has ${live} live subscriptions; workers ignore all past ${BOUNDS.subsPerCreator}, so these won't fire: ${subs
      .slice(-over)
      .map((s) => s.label)
      .join(", ")}. Wait for older ones to expire (≤ 1 day) and rerun.`,
  );
}

const web = process.env.WEB_URL?.trim().replace(/\/$/, "") ?? "";
const bot = process.env.VITE_BOT_NAME?.trim();
console.log("\nsubscription, key, web, telegram");
for (const s of subs)
  console.log(
    [
      s.label,
      s.key,
      `${web}/#/s/${s.key}`,
      bot
        ? `https://t.me/${bot}?start=${encodeKey(s.key)}`
        : "(set VITE_BOT_NAME)",
    ].join("\n  "),
  );
if (rejected) process.exit(1);
