// The new_match search builder (T4.3, LLD §5), part of /new: pick an example entity, tick the
// attributes that matter, see how many records match right now. Reports { search, targetOwner } to
// the page, which validates and signs it like any other subscription.
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import {
  freeCount,
  rawGetEntity,
  type RawEntity,
} from "../../../shared/arkiv.ts";
import { BOUNDS } from "../../../shared/schema.ts";
import { parseSearch } from "../../../shared/searchAst.ts";
import { searchRows, toSearch, type SearchRow } from "../entityForm.ts";
import { reader } from "../wallet.ts";
import { cx, ErrorText, num } from "./kit.tsx";

export type SearchChoice = { search?: unknown; targetOwner?: Hex };

const KEY = /^0x[0-9a-fA-F]{64}$/;
const field =
  "h-9 rounded-[9px] bg-fill px-2.5 text-[15px] outline-none transition-shadow focus:shadow-[0_0_0_2px_var(--accent)]";

type Row = SearchRow & { tick: boolean; op: string; v: string };

function Tick({
  on,
  disabled,
  onChange,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx(
        "grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30",
        on
          ? "bg-accent text-accent-ink"
          : "shadow-[inset_0_0_0_1.5px_var(--ink-3)]",
      )}
    >
      {on && <Check className="size-3.5" strokeWidth={3} />}
    </button>
  );
}

export function SearchBuilder({
  onChange,
}: {
  onChange: (c: SearchChoice) => void;
}) {
  const [example, setExample] = useState("");
  const [entity, setEntity] = useState<RawEntity | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [ownerOnly, setOwnerOnly] = useState(true);
  const [loadError, setLoadError] = useState<unknown>();
  const [query, setQuery] = useState("");
  const [count, setCount] = useState<{ n?: number; error?: unknown }>();

  // Load the example entity's attributes when a full key is pasted.
  useEffect(() => {
    const k = example.trim();
    setEntity(null);
    setRows([]);
    setLoadError(undefined);
    if (!KEY.test(k)) return;
    let live = true;
    rawGetEntity(reader, k as Hex).then(
      (e) => {
        if (!live) return; // the user pasted another key meanwhile
        if (!e) return setLoadError("No live entity has that key.");
        setEntity(e);
        setRows(
          searchRows(e).map((r) => ({
            ...r,
            tick: false,
            op: r.ops[0] ?? "",
            v: r.value,
          })),
        );
      },
      (e) => live && setLoadError(e),
    );
    return () => {
      live = false;
    };
  }, [example]);

  // The choice goes to the page at once; only the match count (a network call) is debounced.
  useEffect(() => {
    const conds = rows
      .filter((r) => r.tick)
      .map((r) => ({ name: r.name, type: r.type, op: r.op, value: r.v }));
    const choice: SearchChoice = {
      search: conds.length ? toSearch(conds) : undefined,
      targetOwner: entity && ownerOnly ? entity.owner : undefined,
    };
    onChange(choice);
    setQuery("");
    setCount(undefined);
    if (!choice.search) return;
    let q: string;
    try {
      q = parseSearch(choice.search).toString();
    } catch {
      return; // the page shows the reason, the same one the worker would log
    }
    setQuery(q);
    let live = true;
    const t = setTimeout(() => {
      // $owner is today's owner, close enough to "creator" for a preview.
      freeCount(
        reader,
        choice.targetOwner
          ? `(${q}) AND $owner = addr(${choice.targetOwner})`
          : q,
      ).then(
        (n) => live && setCount({ n }),
        (error) => live && setCount({ error }),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ownerOnly, entity]);

  const edit = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-[13px] text-ink-2">
          An example of the records you want (its key)
        </span>
        <input
          className={cx(field, "w-full font-mono")}
          placeholder="0x…"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={example}
          onChange={(e) => setExample(e.target.value)}
        />
      </label>
      {loadError !== undefined && <ErrorText error={loadError} />}

      {rows.length > 0 && (
        <div>
          <div className="mb-1.5 text-[13px] text-ink-2">
            Pick the attributes a new record must share
          </div>
          <div className="divide-y divide-sep rounded-[12px] bg-fill/50">
            {rows.map((r, i) => (
              <div
                key={r.name}
                className={cx(
                  "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5",
                  !r.ops.length && "opacity-50",
                )}
              >
                <Tick
                  label={r.name}
                  on={r.tick}
                  disabled={!r.ops.length}
                  onChange={(tick) => edit(i, { tick })}
                />
                <span className="min-w-24 flex-1 font-mono text-[13px]">
                  {r.name}{" "}
                  <span className="font-sans text-ink-3">
                    {r.ops.length ? r.type : `${r.type}, can't be searched`}
                  </span>
                </span>
                {r.ops.length > 0 && (
                  <>
                    <select
                      className={cx(field, "h-8 text-[13px]")}
                      value={r.op}
                      onChange={(e) => edit(i, { op: e.target.value })}
                      aria-label={`${r.name} test`}
                    >
                      {r.ops.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                    <input
                      className={cx(field, "h-8 w-40 font-mono text-[13px]")}
                      value={r.v}
                      onChange={(e) => edit(i, { v: e.target.value })}
                      aria-label={`${r.name} value`}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {entity && (
        <div className="flex items-start gap-3">
          <Tick
            label="Only this creator"
            on={ownerOnly}
            onChange={setOwnerOnly}
          />
          <p className="text-[13px] leading-[1.4]">
            Only records created by{" "}
            <span className="font-mono break-all">{entity.owner}</span>
            <span className="block text-ink-2">
              Otherwise anyone could copy the attributes and set off your
              alerts.
            </span>
          </p>
        </div>
      )}

      {query && (
        <div className="rounded-[12px] bg-fill/50 p-3 text-[13px]">
          <div className="text-ink-2">Watching for</div>
          <div className="mt-0.5 font-mono break-all">{query}</div>
          <div className="mt-2">
            {count?.error !== undefined ? (
              <ErrorText error={count.error} />
            ) : count?.n === undefined ? (
              <span className="text-ink-2">Counting matches…</span>
            ) : count.n === 0 ? (
              <ErrorText error="Nothing matches right now. Check the values: a typo means no alert ever fires." />
            ) : (
              <span
                className={
                  count.n > BOUNDS.maxPerDay.default ? "text-warn" : "text-ok"
                }
              >
                {num(count.n)} record{count.n === 1 ? "" : "s"} match right now
                {count.n > BOUNDS.maxPerDay.default
                  ? `. That's broad: each new one alerts, up to ${BOUNDS.maxPerDay.default} a day.`
                  : "."}
              </span>
            )}
          </div>
        </div>
      )}
      <p className="text-[13px] text-ink-2">
        New records only: existing matches won't alert, and a record edited into
        a match later isn't seen.
      </p>
    </div>
  );
}
