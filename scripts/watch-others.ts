// Watches other hackathon teams' public data, without asking them: Prometheus works on any app's
// entities, not just ours. Run: npm run watch-others   (needs WATCH_PRIVATE_KEY with a little GLM)
//
// Watch-only on purpose: expiring, expired, changed and new_match only read. No `keep`: an extend
// we send can make the owner's own batch revert (SiteLog's friction note F9), and Door Ledger
// relies on leases lapsing when a watcher loses sight of a halt. Keeping their entities alive
// without consent would be sabotage, which the rules ban.
//
// Its own wallet, not the demo subscriber: workers serve 20 subscriptions per creator, and the
// seed needs those. Rerunning adds duplicates; the old ones end on their own after 7 days.
import { addr, key, u64 } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils";
import { formatEther, type Hex } from "viem";
import { publicHttp, rawGetEntity, walletClient } from "../shared/arkiv.ts";
import { encodeKey } from "../shared/deeplink.ts";
import { PROJECT, type Trigger } from "../shared/schema.ts";
import { decodeSubscription } from "../shared/subscription.ts";

const http = process.env.ARKIV_HTTP?.trim();
const pk = process.env.WATCH_PRIVATE_KEY?.trim();
if (!http || !pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("[watch] ARKIV_HTTP or WATCH_PRIVATE_KEY is missing");
  process.exit(1);
}
const accessKey = process.env.ARKIV_ACCESS_KEY?.trim() || undefined;
const pub = publicHttp(http, accessKey);
const wallet = walletClient(pk as Hex, http, accessKey);
const balance = await pub.getBalance({ address: wallet.account.address });
console.log(`[watch] ${wallet.account.address} ${formatEther(balance)} GLM`);
if (balance === 0n) process.exit(1);

// Door Ledger (github.com/bongbongcrypto/door-ledger, arkiv/schema.md): a watcher opens a `lease`
// when it sees an exchange route shut, renews it while the halt lasts, and deletes it on close.
const DOOR_LEDGER_WATCHER_A = "0x65EbE97db5Cd7160bf9a2aa7818241f9E5768A92";
// Arkiv Canary (gitlab.com/davidj-builds/arkiv-canary): a `type = canary` entity that expires
// when its publisher stops renewing it. A renewal patches due_at.
const EXAMPLE_MAIL_CANARY =
  "0xad5ee87066b3d5c58ddf1898d2874182b6a3f09102abc04e3f28fdbee2818219";
const ARKIV_CANARY_SITE_CANARY =
  "0x7a038bab561297ce3b3217adea84f2ed893b3313cd1fa13a8c1939afd5795301";

// 7 days: past judging (19–23 Oct).
const LIFETIME = ExpirationTime.fromDays(7);
const subs: { label: string; key: Hex }[] = [];
async function subscribe(
  label: string,
  trigger: Trigger,
  o: { target?: string; owner?: string; lead?: number; search?: unknown },
) {
  const { entityKey } = await wallet.createEntity({
    payload: jsonToPayload({ v: 1, label, search: o.search }),
    contentType: "application/json",
    attributes: {
      project: PROJECT,
      kind: "subscription",
      trigger,
      ...(o.target && { target_key: key(o.target as Hex) }),
      ...(o.owner && { target_owner: addr(o.owner as Hex) }),
      ...(o.lead !== undefined && { lead_blocks: u64(o.lead) }),
    },
    expires: LIFETIME,
  });
  subs.push({ label, key: entityKey });
}

// Door Ledger: every new halt, and the close of each halt open right now.
await subscribe("Door Ledger: new exchange halt", "new_match", {
  owner: DOOR_LEDGER_WATCHER_A,
  search: {
    and: [
      { eq: ["app", { str: "doorledger" }] },
      { eq: ["kind", { str: "lease" }] },
    ],
  },
});
const open = await pub
  .select({ key: true, attributes: true })
  .where(eq("app", "doorledger"), eq("kind", "lease"))
  .ownedBy(DOOR_LEDGER_WATCHER_A)
  .fetch();
for (const lease of open.entities) {
  const a = lease.attributes;
  await subscribe(
    `Door Ledger: ${a.venue?.value} ${a.route?.value} ${a.side?.value} halt closed`,
    "changed",
    { target: lease.key },
  );
}

// Arkiv Canary: warn an hour before a canary dies, and when it dies or is renewed.
await subscribe("Arkiv Canary: Example Mail Co. dies in 1 h", "expiring", {
  target: EXAMPLE_MAIL_CANARY,
  lead: 1_800,
});
await subscribe("Arkiv Canary: Example Mail Co. died", "expired", {
  target: EXAMPLE_MAIL_CANARY,
});
await subscribe("Arkiv Canary: Example Mail Co. renewed", "changed", {
  target: EXAMPLE_MAIL_CANARY,
});
await subscribe("Arkiv Canary: arkiv-canary.sites.tab.bot died", "expired", {
  target: ARKIV_CANARY_SITE_CANARY,
});
await subscribe("Arkiv Canary: new canary published", "new_match", {
  search: {
    and: [
      { eq: ["app", { str: "arkiv-canary" }] },
      { eq: ["type", { str: "canary" }] },
    ],
  },
});

// Switched Off (github.com/RohanGlitched/switched-off): a new real shutdown order (drills excluded).
await subscribe("Switched Off: new shutdown order", "new_match", {
  search: {
    and: [
      { eq: ["app", { str: "switched-off" }] },
      { eq: ["type", { str: "record" }] },
      { eq: ["net", { str: "live" }] },
    ],
  },
});

// Read each one back as a worker will: a rejected subscription would never fire.
let rejected = 0;
for (const s of subs) {
  const e = await rawGetEntity(pub, s.key);
  const d = e ? decodeSubscription(e) : { ok: false, reason: "not found" };
  if (!d.ok) {
    rejected++;
    console.error(`[watch] ${s.label} ${s.key} rejected: ${d.reason}`);
  }
}

const web = process.env.WEB_URL?.trim().replace(/\/$/, "") ?? "";
const bot = process.env.VITE_BOT_NAME?.trim();
console.log("\nsubscription, key, web, telegram");
for (const s of subs)
  console.log(
    [
      s.label,
      s.key,
      `${web}/s/${s.key}`,
      bot
        ? `https://t.me/${bot}?start=${encodeKey(s.key)}`
        : "(set VITE_BOT_NAME)",
    ].join("\n  "),
  );
if (rejected) process.exit(1);
