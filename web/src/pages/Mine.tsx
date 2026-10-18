// /mine (T4.4, LLD §7): the connected wallet's subscriptions, with renew (extendEntity) and cancel
// (deleteEntity), both signed by that wallet. Rows open in place (bencho pill-accordion).
import { addr } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import {
  BellRing,
  ChevronDown,
  Flame,
  GitCompareArrows,
  Hourglass,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { RawEntity } from "../../../shared/arkiv.ts";
import { BOUNDS, type Trigger } from "../../../shared/schema.ts";
import {
  decodeSubscription,
  servedFirst,
} from "../../../shared/subscription.ts";
import { useWallet } from "../App.tsx";
import { renewChoices } from "../entityForm.ts";
import { fetchEntities } from "../receipts.ts";
import {
  Badge,
  BlocksLoader,
  Button,
  ConfirmButton,
  cx,
  duration,
  ErrorText,
  Group,
  LinkButton,
  PageHead,
  Segmented,
  useLoad,
} from "../ui/kit.tsx";
import { reader, type Wallet } from "../wallet.ts";
import { describe } from "./Status.tsx";

export const TRIGGER_ICON: Record<Trigger, LucideIcon> = {
  expiring: BellRing,
  expired: Hourglass,
  changed: GitCompareArrows,
  keep: Flame,
  new_match: ScanSearch,
};

export function Mine() {
  const { wallet: w } = useWallet();
  const list = useLoad(async () => {
    if (!w) return;
    const [head, entities] = await Promise.all([
      reader.getBlockNumber(),
      fetchEntities(
        eq("kind", "subscription"),
        eq("$creator", addr(w.address)),
      ),
    ]);
    const decoded = entities
      .map((e) => ({ e, d: decodeSubscription(e) }))
      .sort((a, b) => (a.e.createdAt < b.e.createdAt ? 1 : -1)); // newest first
    const served = servedFirst(
      decoded.flatMap(({ d }) => (d.ok ? [d.sub] : [])),
    );
    return { head, decoded, served };
  }, [w?.address]);

  const head = (
    <PageHead
      title="Subscriptions"
      sub="The ones your wallet signed. Renew or cancel them here; you sign those too."
      right={
        // Only beside a list: an empty list has its own button.
        w &&
        !!list.data?.decoded.length && (
          <LinkButton href="/new" variant="primary">
            New subscription
          </LinkButton>
        )
      }
    />
  );

  if (!w)
    return (
      <>
        {head}
        <Group>
          <div className="px-5 py-10 text-center">
            <p className="font-medium">
              Connect a wallet to see your subscriptions
            </p>
            <p className="mt-1 text-[13px] text-ink-2">
              Use Connect wallet at the top of the page.
            </p>
          </div>
        </Group>
      </>
    );

  return (
    <>
      {head}
      {list.error ? (
        <ErrorText error={list.error} />
      ) : !list.data ? (
        <Group>
          <BlocksLoader label="Reading your subscriptions from Arkiv…" />
        </Group>
      ) : !list.data.decoded.length ? (
        <Group>
          <div className="px-5 py-10 text-center">
            <p className="font-medium">No subscriptions yet</p>
            <p className="mt-1 text-[13px] text-ink-2">
              Watch an entity and it shows up here.
            </p>
            <LinkButton href="/new" variant="primary" className="mt-5">
              New subscription
            </LinkButton>
          </div>
        </Group>
      ) : (
        <Group
          note={`Workers serve each wallet's oldest ${BOUNDS.subsPerCreator} subscriptions. Cancelling stops them at once; the receipts stay readable and the deletion is publicly logged.`}
        >
          {list.data.decoded.map(({ e, d }) => (
            <SubRow
              key={e.key}
              w={w}
              e={e}
              d={d}
              head={list.data!.head}
              served={list.data!.served.has(e.key)}
              reload={list.reload}
            />
          ))}
        </Group>
      )}
    </>
  );
}

function SubRow({
  w,
  e,
  d,
  head,
  served,
  reload,
}: {
  w: Wallet;
  e: RawEntity;
  d: ReturnType<typeof decodeSubscription>;
  head: bigint;
  served: boolean;
  reload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const choices = renewChoices(e.expiresAt, head);
  const [days, setDays] = useState<number>(choices[0] ?? 0);
  const label = d.ok ? d.sub.label || "Untitled" : `${e.key.slice(0, 10)}…`;
  const Icon = d.ok ? TRIGGER_ICON[d.sub.trigger] : Hourglass;

  const run = async (
    f: () => Promise<unknown>,
    done: string,
    description?: string,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
      toast.success(done, { description });
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative after:absolute after:right-0 after:bottom-0 after:left-[60px] after:h-px after:bg-sep last:after:hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-fill/50"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-fill text-ink-2">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{label}</span>
          <span className="block truncate text-[13px] text-ink-2">
            {d.ok ? describe(d.sub) : `Workers reject it: ${d.reason}`}
          </span>
        </span>
        <span className="hidden shrink-0 text-right text-[13px] text-ink-2 sm:block">
          Ends in {duration(e.expiresAt - head)}
        </span>
        {!d.ok ? (
          <Badge tone="bad">Rejected</Badge>
        ) : (
          !served && <Badge tone="warn">Not served</Badge>
        )}
        <ChevronDown
          className={cx(
            "size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-out",
            open && "rotate-180",
          )}
        />
      </button>

      {/* grid-rows 0fr → 1fr animates to the content's own height */}
      <div
        className={cx(
          "grid transition-[grid-template-rows] duration-[260ms] ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden" inert={!open}>
          <div className="flex flex-wrap items-center gap-3 px-4 pb-4 pl-[60px]">
            {d.ok && choices.length > 0 && (
              <>
                <Segmented
                  label="Renew for"
                  options={choices.map((c) => ({
                    value: c,
                    label: `${c} day${c > 1 ? "s" : ""}`,
                  }))}
                  value={days}
                  onChange={setDays}
                />
                <Button
                  size="sm"
                  variant="tinted"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        w.client.extendEntity({
                          entityKey: e.key,
                          expires: ExpirationTime.fromDays(days),
                        }),
                      `Renewed "${label}"`,
                      `It now runs ${days} day${days > 1 ? "s" : ""} from now.`,
                    )
                  }
                >
                  Renew
                </Button>
              </>
            )}
            {d.ok && !choices.length && (
              <span className="text-[13px] text-ink-2">
                Already runs the longest term, 30 days.
              </span>
            )}
            <ConfirmButton
              confirm="Cancel it?"
              disabled={busy}
              onConfirm={() =>
                run(
                  () => w.client.deleteEntity({ entityKey: e.key }),
                  `Cancelled "${label}"`,
                  "Workers stop at once. Its receipts stay readable.",
                )
              }
            >
              Cancel
            </ConfirmButton>
            <a
              href={`/s/${e.key}`}
              className="ml-auto text-[13px] text-accent transition-opacity hover:opacity-70"
            >
              Open status
            </a>
            {error !== undefined && (
              <ErrorText error={error} className="w-full" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
