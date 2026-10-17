// The new_match search builder (T4.3, LLD §5), part of #/new: pick an example entity, tick the
// attributes that matter, see how many records match right now. Reports { search, targetOwner } to
// the page, which validates and signs it like any other subscription.
import type { Hex } from "viem";
import { freeCount, rawGetEntity, type RawEntity } from "../../shared/arkiv.ts";
import { BOUNDS } from "../../shared/schema.ts";
import { parseSearch } from "../../shared/searchAst.ts";
import { searchRows, toSearch, type SearchRow } from "./entityForm.ts";
import { errorLine, p, table } from "./router.ts";
import { reader } from "./wallet.ts";

export type SearchChoice = { search?: unknown; targetOwner?: Hex };

const KEY = /^0x[0-9a-fA-F]{64}$/;

type Row = {
  r: SearchRow;
  tick: HTMLInputElement;
  op: HTMLSelectElement;
  value: HTMLInputElement;
};

function rowControls(r: SearchRow): Row {
  const tick = document.createElement("input");
  tick.type = "checkbox";
  tick.disabled = !r.ops.length;
  const op = document.createElement("select");
  for (const o of r.ops) op.append(new Option(o, o));
  const value = document.createElement("input");
  value.value = r.value;
  return { r, tick, op, value };
}

export function searchBuilder(
  el: HTMLElement,
  onChange: (c: SearchChoice) => void,
) {
  el.innerHTML = `
    <p><label>An example of the records you want (its key)<br />
      <input name="example" placeholder="0x…" size="68" autocomplete="off" /></label></p>
    <div class="rows"></div>
    <p class="owner" hidden><label><input name="ownerOnly" type="checkbox" checked />
      Only records created by <code></code> (others could copy the attributes to set off your alerts)</label></p>
    <p class="note">New records only: existing matches won't alert, and a record edited into a match
      later isn't seen.</p>
    <p class="note query"></p>
    <div class="count"></div>`;
  const $ = <T extends Element>(s: string) => el.querySelector<T>(s)!;
  const example = $<HTMLInputElement>("[name=example]");
  const ownerOnly = $<HTMLInputElement>("[name=ownerOnly]");
  const ownerLine = $<HTMLElement>(".owner");
  const rowsBox = $<HTMLElement>(".rows");
  const query = $<HTMLElement>(".query");
  const count = $<HTMLElement>(".count");

  let loadedKey = "";
  let entity: RawEntity | null = null;
  let rows: Row[] = [];
  let seq = 0;
  let timer: ReturnType<typeof setTimeout>;

  async function loadExample(k: string) {
    loadedKey = k;
    entity = null;
    rows = [];
    rowsBox.replaceChildren();
    ownerLine.hidden = true;
    if (!KEY.test(k)) return;
    const e = await rawGetEntity(reader, k as Hex);
    if (k !== loadedKey) return; // the user pasted another key meanwhile
    if (!e) {
      rowsBox.replaceChildren(errorLine("No live entity has that key."));
      return;
    }
    entity = e;
    rows = searchRows(e).map(rowControls);
    rowsBox.replaceChildren(
      table(
        ["", "Attribute", "Type", "Test", "Value"],
        rows.map((x) => [
          x.tick,
          x.r.name,
          x.r.ops.length ? x.r.type : `${x.r.type} (can't be searched)`,
          x.op,
          x.value,
        ]),
      ),
    );
    ownerLine.querySelector("code")!.textContent = e.owner;
    ownerLine.hidden = false;
  }

  // The choice goes to the page at once; only the match count (a network call) is debounced.
  function update() {
    const conds = rows
      .filter((x) => x.tick.checked)
      .map((x) => ({
        name: x.r.name,
        type: x.r.type,
        op: x.op.value,
        value: x.value.value,
      }));
    const choice: SearchChoice = {
      search: conds.length ? toSearch(conds) : undefined,
      targetOwner: entity && ownerOnly.checked ? entity.owner : undefined,
    };
    onChange(choice);
    clearTimeout(timer);
    timer = setTimeout(() => void preview(choice), 400);
  }

  async function preview({ search, targetOwner }: SearchChoice) {
    const mine = ++seq;
    query.textContent = "";
    count.replaceChildren();
    if (!search) return;
    let q: string;
    try {
      q = parseSearch(search).toString();
    } catch {
      return; // the page shows the reason, the same one the worker would log
    }
    query.textContent = `Watching for: ${q}${targetOwner ? `, created by ${targetOwner}` : ""}`;
    try {
      // $owner is today's owner, close enough to "creator" for a preview.
      const n = await freeCount(
        reader,
        targetOwner ? `(${q}) AND $owner = addr(${targetOwner})` : q,
      );
      if (mine !== seq) return;
      count.replaceChildren(
        n === 0
          ? errorLine(
              "Nothing matches right now. Check the values: a typo means no alert ever fires.",
            )
          : p(
              `${n} record${n === 1 ? "" : "s"} match right now.`,
              n > BOUNDS.maxPerDay.default
                ? ` That's broad: each new one alerts, up to ${BOUNDS.maxPerDay.default} a day.`
                : "",
            ),
      );
    } catch (e) {
      if (mine === seq) count.replaceChildren(errorLine(e));
    }
  }

  el.addEventListener("input", async (ev) => {
    if (ev.target === example && example.value.trim() !== loadedKey) {
      await loadExample(example.value.trim()).catch((e) =>
        rowsBox.replaceChildren(errorLine(e)),
      );
    }
    update();
  });
}
