// #/coverage (T4.6, LLD §7): public proof of reliability and gaps, read straight from Arkiv. Each
// section loads on its own, so a rate-limited query blanks only its section.
import { u64 } from "@arkiv-network/sdk/attr";
import { eq, gte } from "@arkiv-network/sdk/query";
import {
  freeCount,
  rawGetEntity,
  trustedFilter,
} from "../../../shared/arkiv.ts";
import { inBatches } from "../../../shared/limit.ts";
import { BLOCKS_PER_DAY, PROJECT } from "../../../shared/schema.ts";
import { decodeSubscription } from "../../../shared/subscription.ts";
import {
  expiredGaps,
  groupByTrigger,
  rowStatus,
  summarize,
  workerName,
  type TriggerRow,
  type WorkerStat,
} from "../coverage.ts";
import {
  EXPLORER,
  fetchEntities,
  fetchReceipts,
  TRUSTED,
} from "../receiptsView.ts";
import { errorLine, link, p, table } from "../router.ts";
import { reader } from "../wallet.ts";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// A worker's heartbeat entity lapses within 30 min of it stopping (LLD §2.1): free count per worker.
const liveness = () =>
  Promise.all(
    TRUSTED.map(
      async (a) =>
        (await freeCount(
          reader,
          `project = str('${PROJECT}') AND kind = str('worker') AND $creator = addr(${a})`,
        )) > 0,
    ),
  );

// Live `expired` subscriptions → is the target gone, and did a trusted worker write its receipt?
// ponytail: a creator's subscriptions past the 20-cap are never served and would show here as gaps;
// filter them with SubsIndex if that ever happens outside tests.
async function expiredChecks() {
  const trusted = trustedFilter(TRUSTED);
  const subs = (
    await fetchEntities(eq("kind", "subscription"), eq("trigger", "expired"))
  )
    .map(decodeSubscription)
    .flatMap((d) => (d.ok ? [d.sub] : []));
  return inBatches(subs, async (sub) => {
    const targetLive = !!(await rawGetEntity(reader, sub.targetKey!));
    const receipts = targetLive
      ? 0
      : await freeCount(
          reader,
          `project = str('${PROJECT}') AND kind = str('receipt') AND subscription = key(${sub.key}) AND event = str('expired') AND ${trusted}`,
        );
    return { sub, targetLive, receipts };
  });
}

const lateText = (l: bigint | undefined) =>
  l === undefined ? "–" : `${l} blocks`;

function workersTable(workers: WorkerStat[]) {
  return table(
    [
      "Worker",
      "Address",
      "Status",
      "Delivered",
      "Only by it",
      "Late (median / max)",
    ],
    workers.map((w) => [
      w.name,
      link(`${EXPLORER}/address/${w.address}`, short(w.address)),
      `${w.live ? "live" : "offline"}${w.lowFunds ? " · low on funds" : ""}`,
      String(w.delivered),
      String(w.only),
      `${lateText(w.medianLate)} / ${lateText(w.maxLate)}`,
    ]),
  );
}

function triggersTable(rows: TriggerRow[]) {
  if (!rows.length) return p("No triggers in the last 24 h.");
  return table(
    [
      "Event",
      "Subject",
      "Trigger block",
      ...TRUSTED.map((_, i) => workerName(i)),
      "Status",
    ],
    rows.map((r) => [
      link(`#/s/${r.subscription}`, r.event),
      link(`${EXPLORER}/entity/${r.subject}`, short(r.subject)),
      String(r.triggerBlock),
      ...TRUSTED.map((a) => {
        if (!r.late.has(a)) return "—";
        const l = r.late.get(a);
        return l === undefined ? "✓" : `✓ ${l}`;
      }),
      rowStatus(r, TRUSTED),
    ]),
  );
}

export async function coveragePage(el: HTMLElement) {
  if (!TRUSTED.length)
    throw new Error("This site has no trusted workers configured.");
  el.textContent = "Loading…";
  const head = await reader.getBlockNumber();

  const title = document.createElement("h2");
  title.textContent = "Coverage, last 24 h";
  const box = () => {
    const d = document.createElement("div");
    d.textContent = "Loading…";
    return d;
  };
  const h3 = (text: string) => {
    const h = document.createElement("h3");
    h.textContent = text;
    return h;
  };
  const top = box();
  const gaps = box();
  const triggers = box();
  const note = p(
    `Since block ${head - BigInt(BLOCKS_PER_DAY)}. Worker A acts first; B waits and acts only on what A missed. Receipts can't be rewritten; deletion is publicly logged.`,
  );
  note.className = "note";
  el.replaceChildren(
    title,
    note,
    top,
    h3("Gaps"),
    gaps,
    h3("Triggers"),
    triggers,
  );

  const section = async (target: HTMLElement, fill: () => Promise<Node[]>) => {
    try {
      target.replaceChildren(...(await fill()));
    } catch (e) {
      target.replaceChildren(errorLine(e));
    }
  };

  const data = Promise.all([
    fetchReceipts(gte("trigger_block", u64(head - BigInt(BLOCKS_PER_DAY)))),
    liveness(),
  ]).then(([receipts, live]) => {
    const rows = groupByTrigger(receipts);
    return { rows, ...summarize(receipts, rows, TRUSTED, live) };
  });
  data.catch(() => {}); // each section reports the failure itself

  await Promise.all([
    section(top, async () => {
      const d = await data;
      const headline = document.createElement("h3");
      headline.textContent = d.headline;
      return [headline, workersTable(d.workers)];
    }),
    section(triggers, async () => [triggersTable((await data).rows)]),
    section(gaps, async () => {
      const list = expiredGaps(await expiredChecks());
      const caveat = p(
        "Expired subscriptions whose target is gone with no receipt. One that expired in the last minute can show here until its receipt lands.",
      );
      caveat.className = "note";
      if (!list.length)
        return [caveat, p("None: every gone target has its receipt.")];
      return [
        caveat,
        table(
          ["Subscription", "Target"],
          list.map((s) => [
            link(`#/s/${s.key}`, s.label),
            link(`${EXPLORER}/entity/${s.targetKey}`, short(s.targetKey!)),
          ]),
        ),
      ];
    }),
  ]);
}
