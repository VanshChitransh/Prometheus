// #/mine (T4.4, LLD §7): the connected wallet's subscriptions, with renew (extendEntity) and cancel
// (deleteEntity), both signed by that wallet.
import { addr } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import type { Hex } from "viem";
import { BOUNDS } from "../../../shared/schema.ts";
import {
  decodeSubscription,
  servedFirst,
} from "../../../shared/subscription.ts";
import { renewChoices, span } from "../entityForm.ts";
import { fetchEntities } from "../receiptsView.ts";
import { errorLine, link, p, table } from "../router.ts";
import { reader, wallet, type Wallet } from "../wallet.ts";
import { describe } from "./status.ts";

function button(text: string, onClick: () => unknown) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

export async function minePage(el: HTMLElement) {
  const w = wallet();
  if (!w) {
    el.replaceChildren(
      p("Connect a wallet (top right) to see your subscriptions."),
    );
    return;
  }
  el.textContent = "Loading…";
  const [head, entities] = await Promise.all([
    reader.getBlockNumber(),
    fetchEntities(eq("kind", "subscription"), eq("$creator", addr(w.address))),
  ]);
  const decoded = entities.map((e) => ({ e, d: decodeSubscription(e) }));
  const served = servedFirst(decoded.flatMap(({ d }) => (d.ok ? [d.sub] : [])));

  const title = document.createElement("h2");
  title.textContent = "My subscriptions";
  if (!decoded.length) {
    el.replaceChildren(
      title,
      p("None yet. ", link("#/new", "Create a subscription")),
    );
    return;
  }

  const reload = () =>
    void minePage(el).catch((e) => el.replaceChildren(errorLine(e)));
  const rows = decoded
    .sort((a, b) => (a.e.createdAt < b.e.createdAt ? 1 : -1)) // newest first
    .map(({ e, d }) => {
      const status = !d.ok
        ? `rejected by workers: ${d.reason}`
        : served.has(e.key)
          ? "served"
          : `not served: over the ${BOUNDS.subsPerCreator} cap`;
      const what = d.ok
        ? [
            link(`#/s/${e.key}`, d.sub.label),
            document.createElement("br"),
            describe(d.sub),
          ]
        : [link(`#/s/${e.key}`, `${e.key.slice(0, 10)}…`)];
      const actions = document.createElement("span");
      const done = (err?: unknown) =>
        err ? actions.replaceChildren(errorLine(err)) : reload();
      if (d.ok)
        actions.append(renewControl(w, e.key, e.expiresAt, head, done), " ");
      actions.append(
        button("Cancel", async () => {
          const label = d.ok ? `"${d.sub.label}"` : "this subscription";
          if (
            !confirm(
              `Cancel ${label}? Workers stop at once. Its receipts stay readable; the deletion is publicly logged.`,
            )
          )
            return;
          try {
            await w.client.deleteEntity({ entityKey: e.key });
            done();
          } catch (err) {
            done(err);
          }
        }),
      );
      const ends = document.createElement("span");
      ends.append(
        `block ${e.expiresAt} (${span(e.expiresAt - head)})`,
        d.ok && d.sub.publicMonitor ? " · public monitor" : "",
      );
      return [p(...what), ends, status, actions];
    });

  el.replaceChildren(
    title,
    table(["Subscription", "Runs until", "Status", ""], rows),
  );
}

// Only terms that would move the expiry later: the engine rejects the rest.
function renewControl(
  w: Wallet,
  entityKey: Hex,
  expiresAt: bigint,
  head: bigint,
  done: (err?: unknown) => void,
) {
  const choices = renewChoices(expiresAt, head);
  const out = document.createElement("span");
  if (!choices.length) {
    out.textContent = "Already runs 30 days.";
    return out;
  }
  const pick = document.createElement("select");
  for (const d of choices)
    pick.append(new Option(`${d} day${d > 1 ? "s" : ""}`, String(d)));
  out.append(
    pick,
    " ",
    button("Renew", async () => {
      try {
        await w.client.extendEntity({
          entityKey,
          expires: ExpirationTime.fromDays(Number(pick.value)),
        });
        done();
      } catch (err) {
        done(err);
      }
    }),
  );
  return out;
}
