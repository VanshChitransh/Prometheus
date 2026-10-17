// #/new (T4.2, LLD §7): a subscription signed by the user's own wallet. Everything the worker would
// reject is caught here first, with the worker's own reason, before anything is signed.
import { zeroAddress, type Hex } from "viem";
import {
  freeCount,
  rawGetEntity,
  type RawEntity,
} from "../../../shared/arkiv.ts";
import { encodeKey } from "../../../shared/deeplink.ts";
import { BOUNDS, PROJECT, type Trigger } from "../../../shared/schema.ts";
import {
  decodeSubscription,
  keepBlocked,
} from "../../../shared/subscription.ts";
import { span, toDraft, toParams, type FormValues } from "../entityForm.ts";
import { errorLine, link } from "../router.ts";
import { reader, wallet } from "../wallet.ts";

declare const __BOT_NAME__: string; // vite.config.ts

const KEY = /^0x[0-9a-fA-F]{64}$/;

const SKIP_TEXT = {
  not_permissionless:
    "Its creator didn't allow anyone else to renew it, so every keep will be skipped.",
  deny_listed:
    "It looks like a canary or heartbeat (or is a Prometheus entity), so every keep will be skipped.",
};

export function newPage(el: HTMLElement) {
  el.innerHTML = `
    <h2>New subscription</h2>
    <form>
      <p><label>Entity to watch (its key)<br />
        <input name="target" placeholder="0x…" size="68" autocomplete="off" /></label></p>
      <p class="note" id="preview"></p>
      <p><label>Do this<br /><select name="trigger">
        <option value="expiring">Warn me before it expires</option>
        <option value="expired">Tell me when it has expired</option>
        <option value="changed">Tell me when it changes, changes owner or is deleted</option>
        <option value="keep">Keep it alive: renew it before it expires</option>
      </select></label></p>
      <p data-for="expiring keep"><label>Minutes before expiry<br />
        <input name="lead" type="number" min="1" max="1440" value="10" /></label></p>
      <p data-for="keep"><label>Hours added per renewal<br />
        <input name="keep" type="number" min="1" max="720" value="24" /></label></p>
      <p><label>Label (shown in your alerts)<br />
        <input name="label" maxlength="80" /></label></p>
      <p><label>Subscription lasts <select name="term">
        <option value="1">1 day</option><option value="7" selected>7 days</option>
        <option value="30">30 days</option></select></label></p>
      <p><label><input name="public" type="checkbox" />
        Public monitor: anyone may renew this subscription</label></p>
      <div id="problem"></div>
      <button>Sign and create</button>
    </form>
    <div id="result"></div>`;

  const form = el.querySelector("form")!;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const preview = el.querySelector<HTMLElement>("#preview")!;
  const problem = el.querySelector<HTMLElement>("#problem")!;
  const result = el.querySelector<HTMLElement>("#result")!;
  const button = form.querySelector("button")!;

  const values = (): FormValues => ({
    trigger: field("trigger").value as Trigger,
    targetKey: field("target").value,
    leadMinutes: Number(field("lead").value),
    keepHours: Number(field("keep").value),
    termDays: Number(field("term").value),
    label: field("label").value,
    publicMonitor: field("public").checked,
  });

  // The target read is cached per key: it's free, but not worth one per keystroke.
  let target: { key: string; entity: RawEntity | null } | undefined;
  let seq = 0;

  // Re-validates the whole form. Returns the draft only when it may be signed.
  async function check() {
    const mine = ++seq;
    const v = values();
    for (const p of el.querySelectorAll<HTMLElement>("[data-for]"))
      p.hidden = !p.dataset.for!.split(" ").includes(v.trigger);

    const head = await reader.getBlockNumber();
    const k = v.targetKey.trim();
    if (KEY.test(k) && target?.key !== k)
      target = { key: k, entity: await rawGetEntity(reader, k as Hex) };
    if (mine !== seq) return; // a newer check is running; let it render

    const draft = toDraft(v, wallet()?.address ?? zeroAddress, head);
    const d = decodeSubscription(draft);
    const t = KEY.test(k) && target?.key === k ? target.entity : undefined;

    const notes: string[] = [];
    let blocker = d.ok ? "" : d.reason;
    if (t === null) blocker ||= "No live entity has that key.";
    if (t) {
      const left = t.expiresAt - head;
      notes.push(`Expires at block ${t.expiresAt} (${span(left)} from now).`);
      const lead = draft.attributes.lead_blocks as bigint | undefined;
      if (v.trigger === "expiring" && lead !== undefined && lead >= left)
        notes.push(
          "That's sooner than your lead time, so the warning fires right away.",
        );
      const skip = v.trigger === "keep" && keepBlocked(t);
      if (skip) notes.push(SKIP_TEXT[skip]);
      if (v.trigger !== "changed" && draft.expiresAt < t.expiresAt)
        notes.push("Your subscription ends before the entity expires.");
    }
    preview.replaceChildren(notes.join(" "));
    problem.replaceChildren(blocker ? errorLine(blocker) : "");
    return blocker ? undefined : { draft, v };
  }

  const rerun = () =>
    void check().catch((e) => problem.replaceChildren(errorLine(e)));
  let timer: ReturnType<typeof setTimeout>;
  form.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(rerun, 300);
  };
  rerun();

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    button.disabled = true;
    try {
      const w = wallet();
      if (!w) throw new Error("Connect a wallet first (top right).");
      const ok = await check();
      if (!ok) return;
      // The worker ignores a creator's subscriptions past the cap, newest first: it would never fire.
      const live = await freeCount(
        reader,
        `project = str('${PROJECT}') AND kind = str('subscription') AND $creator = addr(${w.address})`,
      );
      if (live >= BOUNDS.subsPerCreator)
        throw new Error(
          `This wallet already has ${live} live subscriptions; workers serve only the oldest ${BOUNDS.subsPerCreator}.`,
        );
      if ((await reader.getBalance({ address: w.address })) === 0n)
        throw new Error(
          "This wallet has 0 GLM, and creating a subscription costs gas. Fund it first.",
        );
      const { entityKey } = await w.client.createEntity(
        toParams(ok.draft, ok.v.termDays),
      );
      showResult(entityKey, ok.v.label.trim());
    } catch (e) {
      problem.replaceChildren(errorLine(e));
    } finally {
      button.disabled = false;
    }
  };

  function showResult(key: Hex, label: string) {
    const head = document.createElement("p");
    const code = document.createElement("code");
    code.textContent = key;
    head.append(`Created "${label}": `, code);
    const links = document.createElement("p");
    links.append(link(`#/s/${key}`, "See its status"));
    if (__BOT_NAME__)
      links.append(
        " · ",
        link(
          `https://t.me/${__BOT_NAME__}?start=${encodeKey(key)}`,
          "Follow in Telegram",
        ),
      );
    else links.append(" · Telegram alerts aren't configured for this site.");
    result.replaceChildren(head, links);
  }
}
