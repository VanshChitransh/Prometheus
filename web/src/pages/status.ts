// #/s/:key (T4.5, LLD §7): what a subscription watches and what the workers did, read straight from
// Arkiv. Needs no relay and no worker: it works with all of them stopped.
import { key } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import type { Hex } from "viem";
import { rawGetEntity } from "../../../shared/arkiv.ts";
import { decodeSubscription, type Sub } from "../../../shared/subscription.ts";
import { span } from "../entityForm.ts";
import { EXPLORER, fetchReceipts, renderReceipts } from "../receiptsView.ts";
import { errorLine, link } from "../router.ts";
import { reader } from "../wallet.ts";

const MS_PER_BLOCK = 2_000;

const p = (...parts: (string | Node)[]) => {
  const el = document.createElement("p");
  el.append(...parts);
  return el;
};
const code = (text: string) => {
  const el = document.createElement("code");
  el.textContent = text;
  return el;
};

function describe(s: Sub) {
  switch (s.trigger) {
    case "expiring":
      return `Warns ${span(s.leadBlocks!)} before the entity expires.`;
    case "expired":
      return "Tells when the entity has expired.";
    case "changed":
      return "Tells when the entity changes, changes owner or is deleted.";
    case "keep":
      return `Renews the entity ${span(s.leadBlocks!)} before it expires, adding ${span(s.keepBlocks!)} each time.`;
    case "new_match":
      return `Tells when a new entity matches its search${s.targetOwner ? ` (owner ${s.targetOwner})` : ""}.`;
  }
}

// "1 h 02 min 05 s" from milliseconds.
function clock(ms: number) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h ? `${h} h ` : ""}${String(m).padStart(2, "0")} min ${String(s).padStart(2, "0")} s`;
}

// Counts down locally from one head read: a block every 2 s, no polling. Stops once the user leaves.
function countdown(expiresAt: bigint, head: bigint) {
  const out = document.createElement("span");
  const deadline = Date.now() + Number(expiresAt - head) * MS_PER_BLOCK;
  const render = () => {
    const left = deadline - Date.now();
    out.textContent = left > 0 ? `in ${clock(left)}` : "about now";
    return left;
  };
  // The first render runs before the span is on the page; later ticks stop once it's gone.
  const timer = setInterval(() => {
    if (!out.isConnected || render() <= 0) clearInterval(timer);
  }, 1000);
  render();
  return out;
}

export async function statusPage(el: HTMLElement, subKey: string) {
  el.textContent = "Loading…";
  const [head, entity] = await Promise.all([
    reader.getBlockNumber(),
    rawGetEntity(reader, subKey as Hex),
  ]);
  const d = entity && decodeSubscription(entity);
  if (d && !d.ok) {
    el.replaceChildren(
      errorLine(`Not a valid Prometheus subscription: ${d.reason}`),
    );
    return;
  }

  const parts: Node[] = [];
  if (!d) {
    parts.push(
      p(
        "This subscription is no longer live: it ran out or was cancelled. Its receipts stay readable for 30 days.",
      ),
    );
  } else {
    const s = d.sub;
    const title = document.createElement("h2");
    title.textContent = s.label;
    parts.push(
      title,
      p(describe(s)),
      p(
        "Created by ",
        link(`${EXPLORER}/address/${s.creator}`, s.creator),
        `. Runs until block ${s.expiresAt} (${span(s.expiresAt - head)} from now).`,
        s.publicMonitor ? " Public monitor: anyone may renew it." : "",
      ),
    );
    if (s.targetKey) {
      const t = await rawGetEntity(reader, s.targetKey);
      parts.push(
        p("Watching ", link(`${EXPLORER}/entity/${s.targetKey}`, s.targetKey)),
        t
          ? p(
              `Expires at block ${t.expiresAt}, `,
              countdown(t.expiresAt, head),
              ". Owner ",
              code(t.owner),
              ".",
            )
          : p("It's no longer on Arkiv: it wasn't renewed, or it was deleted."),
      );
    }
  }

  const heading = document.createElement("h3");
  heading.textContent = "Receipts";
  const receipts = document.createElement("div");
  receipts.textContent = "Loading receipts…";
  el.replaceChildren(...parts, heading, receipts);

  // Separate from the rest: a rate-limited receipt query still leaves the subscription on screen.
  try {
    const list = await fetchReceipts(eq("subscription", key(subKey as Hex)));
    receipts.replaceChildren(...renderReceipts(list));
  } catch (e) {
    receipts.replaceChildren(errorLine(e));
  }
}
