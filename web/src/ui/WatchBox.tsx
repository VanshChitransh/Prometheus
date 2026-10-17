// The home page's hero: the product itself. Paste an entity key (read at once, free), choose what
// should happen, connect a wallet, then review and sign on #/new with everything filled in.
import { u64 } from "@arkiv-network/sdk/attr";
import { eq, gte } from "@arkiv-network/sdk/query";
import { ClipboardPaste } from "lucide-react";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { rawGetEntity, type RawEntity } from "../../../shared/arkiv.ts";
import { BLOCKS_PER_DAY, type Trigger } from "../../../shared/schema.ts";
import { useWallet } from "../App.tsx";
import { fetchReceipts } from "../receipts.ts";
import { reader } from "../wallet.ts";
import { Button, cx, duration, ErrorText, num } from "./kit.tsx";
import { LiveRuler } from "./Ruler.tsx";
import { openWallet } from "./WalletMenu.tsx";

const KEY = /^0x[0-9a-fA-F]{64}$/;

const CHOICES: { id: Trigger; label: string }[] = [
  { id: "expiring", label: "Warn me before it expires" },
  { id: "expired", label: "Tell me when it's gone" },
  { id: "changed", label: "Tell me when it changes" },
  { id: "keep", label: "Keep it alive" },
];

const Step = ({
  n,
  children,
  done,
}: {
  n: number;
  children: string;
  done?: boolean;
}) => (
  <div className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
    <span
      className={cx(
        "tnum grid size-5 place-items-center rounded-full text-[11px] transition-colors",
        done ? "bg-accent text-accent-ink" : "bg-fill-strong text-ink-2",
      )}
    >
      {n}
    </span>
    {children}
  </div>
);

export function WatchBox() {
  const { wallet } = useWallet();
  const [key, setKey] = useState("");
  const [trigger, setTrigger] = useState<Trigger>("expiring");
  const [found, setFound] = useState<{
    key: string;
    head: bigint;
    entity: RawEntity | null;
  }>();
  const [problem, setProblem] = useState("");
  const [finding, setFinding] = useState(false);
  const k = key.trim();

  // A full key is read straight away (a free call), so the box shows that entity's real expiry.
  useEffect(() => {
    setProblem("");
    if (!KEY.test(k)) return setFound(undefined);
    let live = true;
    Promise.all([reader.getBlockNumber(), rawGetEntity(reader, k as Hex)]).then(
      ([head, entity]) => live && setFound({ key: k, head, entity }),
      (e) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [k]);

  // A live entity a worker kept alive in the last day: something real to try with.
  async function example() {
    setFinding(true);
    setProblem("");
    try {
      const head = await reader.getBlockNumber();
      const kept = await fetchReceipts(
        eq("event", "kept"),
        gte("trigger_block", u64(head - BigInt(BLOCKS_PER_DAY))),
      );
      for (const r of kept)
        if (await rawGetEntity(reader, r.subject)) {
          setKey(r.subject);
          return;
        }
      setProblem("No live example right now. Paste any entity key instead.");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setFinding(false);
    }
  }

  const ready = !!found?.entity;
  const go = () => (location.hash = `#/new/${k}/${trigger}`);

  return (
    <div className="rounded-[24px] border border-sep bg-cell p-5 shadow-float sm:p-6">
      <Step n={1} done={ready}>
        Paste the entity you want to watch
      </Step>
      <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-page py-1.5 pr-1.5 pl-4 shadow-[inset_0_0_0_1px_var(--sep)] transition-shadow focus-within:shadow-[inset_0_0_0_2px_var(--accent)]">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Entity key, 0x…"
          aria-label="Entity key"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="h-10 min-w-0 flex-1 bg-transparent font-mono text-[14px] tracking-[-0.01em] outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-ink-3"
        />
        <Button
          size="sm"
          onClick={async () => {
            try {
              setKey((await navigator.clipboard.readText()).trim());
            } catch {
              /* the browser said no; typing still works */
            }
          }}
        >
          <ClipboardPaste className="size-3.5" /> Paste
        </Button>
      </div>

      <div className="mt-3 min-h-[20px] text-[13px]">
        {problem ? (
          <ErrorText error={problem} />
        ) : found?.entity === null ? (
          <ErrorText error="No live entity has that key. It may have expired already." />
        ) : ready ? (
          <span className="tnum text-ink-2">
            Expires at block {num(found!.entity!.expiresAt)}, in{" "}
            <span className="font-medium text-ink">
              {duration(found!.entity!.expiresAt - found!.head)}
            </span>
            .
          </span>
        ) : k && !KEY.test(k) ? (
          <span className="text-ink-3">
            A key is 0x followed by 64 hex characters.
          </span>
        ) : (
          <button
            type="button"
            onClick={example}
            disabled={finding}
            className="cursor-pointer text-accent transition-opacity hover:opacity-75 disabled:opacity-50"
          >
            {finding
              ? "Finding a live entity…"
              : "No key handy? Try a live one"}
          </button>
        )}
      </div>

      {ready && (
        <div className="mt-2">
          <LiveRuler
            key={found!.key}
            head={found!.head}
            expiresAt={found!.entity!.expiresAt}
            trigger={trigger}
            leadBlocks={300n}
            keepBlocks={43_200n}
          />
        </div>
      )}

      <div className="mt-5">
        <Step n={2} done={ready}>
          Choose what should happen
        </Step>
        <div
          className="mt-3 grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label="What should happen"
        >
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={trigger === c.id}
              onClick={() => setTrigger(c.id)}
              className={cx(
                "cursor-pointer rounded-[12px] px-3 py-2.5 text-left text-[13px] font-medium transition-[background-color,box-shadow,color] duration-150 active:scale-[0.98]",
                trigger === c.id
                  ? "bg-accent-soft text-ink shadow-[inset_0_0_0_1.5px_var(--accent)]"
                  : "bg-fill text-ink-2 hover:text-ink",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <a
          href="#/new/new_match"
          className="mt-2 inline-block text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          Or get told about new entities that match a search
        </a>
      </div>

      <div className="mt-5 border-t border-sep pt-5">
        <Step n={3} done={!!wallet}>
          {wallet ? "Wallet connected" : "Connect your wallet and sign"}
        </Step>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {wallet ? (
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!ready}
              onClick={go}
            >
              Review and sign
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              onClick={openWallet}
            >
              Connect wallet
            </Button>
          )}
        </div>
        <p className="mt-3 text-[12px] leading-[1.45] text-ink-3">
          Free on Arkiv's testnet. The subscription is signed by your own
          wallet; in Telegram we create one for you and cover the fee.
        </p>
      </div>
    </div>
  );
}
