// #/s/:key (T4.5, LLD §7): what a subscription watches and what the workers did, read straight from
// Arkiv. Needs no relay and no worker: it works with all of them stopped. Telegram alerts link here.
import { key } from "@arkiv-network/sdk/attr";
import { eq } from "@arkiv-network/sdk/query";
import { Send } from "lucide-react";
import type { ReactNode } from "react";
import type { Hex } from "viem";
import { encodeKey } from "../../../shared/deeplink.ts";
import { rawGetEntity, type RawEntity } from "../../../shared/arkiv.ts";
import type { Trigger } from "../../../shared/schema.ts";
import { decodeSubscription, type Sub } from "../../../shared/subscription.ts";
import { EXPLORER, fetchReceipts } from "../receipts.ts";
import { telegramClick } from "../telegram.ts";
import {
  Badge,
  BlocksLoader,
  Countdown,
  duration,
  ErrorText,
  Group,
  Hash,
  LinkButton,
  num,
  PageHead,
  Row,
  Skeleton,
  useLoad,
  useRemaining,
  type Tone,
} from "../ui/kit.tsx";
import { Receipts } from "../ui/Receipts.tsx";
import { LiveRuler } from "../ui/Ruler.tsx";
import { reader } from "../wallet.ts";

declare const __BOT_NAME__: string; // vite.config.ts

export const TRIGGER_NAME: Record<Trigger, [string, Tone]> = {
  expiring: ["Expiry warning", "warn"],
  expired: ["Expiry alert", "bad"],
  changed: ["Change watch", "accent"],
  keep: ["Keep alive", "ok"],
  new_match: ["New match", "accent"],
};

export function describe(s: Sub) {
  switch (s.trigger) {
    case "expiring":
      return `Warns ${duration(s.leadBlocks!)} before the entity expires.`;
    case "expired":
      return "Tells you when the entity has expired.";
    case "changed":
      return "Tells you when the entity changes, changes owner or is deleted.";
    case "keep":
      return `Renews the entity ${duration(s.leadBlocks!)} before it expires, adding ${duration(s.keepBlocks!)} each time.`;
    case "new_match":
      return `Tells you about each new record matching ${s.search}${s.targetOwner ? `, created by ${s.targetOwner}` : ""}. New records only.`;
  }
}

export function Status({ params: [subKey] }: { params: string[] }) {
  const main = useLoad(async () => {
    const [head, entity] = await Promise.all([
      reader.getBlockNumber(),
      rawGetEntity(reader, subKey as Hex),
    ]);
    const d = entity && decodeSubscription(entity);
    const target =
      d && d.ok && d.sub.targetKey
        ? await rawGetEntity(reader, d.sub.targetKey)
        : undefined;
    return { head, d, target };
  }, [subKey]);
  // Separate: a rate-limited receipt query still leaves the subscription on screen.
  const receipts = useLoad(
    () => fetchReceipts(eq("subscription", key(subKey as Hex))),
    [subKey],
  );

  return (
    <div className="space-y-10">
      {main.error ? (
        <ErrorText error={main.error} />
      ) : !main.data ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-80" />
          <Skeleton className="h-5 w-96" />
          <Skeleton className="mt-8 h-64 w-full rounded-[22px]" />
        </div>
      ) : (
        <Overview subKey={subKey} {...main.data} />
      )}

      <section>
        <div className="mb-2 flex items-end justify-between px-4">
          <h2 className="text-[13px] font-medium text-ink-2">Receipts</h2>
          {receipts.data && (
            <span className="tnum text-[13px] text-ink-3">
              {receipts.data.length}
            </span>
          )}
        </div>
        {receipts.error ? (
          <ErrorText error={receipts.error} className="px-4" />
        ) : !receipts.data || !main.data ? (
          <Group>
            <BlocksLoader label="Reading receipts from Arkiv…" />
          </Group>
        ) : (
          <Receipts list={receipts.data} head={main.data.head} />
        )}
        <p className="mt-2 px-4 text-[13px] text-ink-2">
          Written by trusted workers. Receipts can't be rewritten; deletion is
          publicly logged.
        </p>
      </section>
    </div>
  );
}

type Loaded = {
  subKey: string;
  head: bigint;
  d: ReturnType<typeof decodeSubscription> | null;
  target: RawEntity | null | undefined;
};

function Overview({ subKey, head, d, target }: Loaded) {
  if (d && !d.ok)
    return (
      <ErrorText
        error={`This isn't a valid Prometheus subscription: ${d.reason}`}
      />
    );
  if (!d)
    return (
      <PageHead
        title="This subscription has ended"
        sub="It ran out or was cancelled, so workers no longer act on it. Its receipts stay readable for 30 days."
      />
    );

  const s = d.sub;
  const [name, tone] = TRIGGER_NAME[s.trigger];
  const tme = __BOT_NAME__
    ? `https://t.me/${__BOT_NAME__}?start=${encodeKey(subKey as Hex)}`
    : "";
  return (
    <>
      <PageHead
        title={s.label || "Untitled subscription"}
        sub={describe(s)}
        right={
          tme && (
            <LinkButton
              href={tme}
              variant="tinted"
              onClick={telegramClick(tme)}
            >
              <Send className="size-4" /> Follow in Telegram
            </LinkButton>
          )
        }
      />

      <section className="rounded-[22px] bg-cell p-5 sm:p-7">
        {s.targetKey ? (
          target ? (
            <TargetClock s={s} target={target} head={head} />
          ) : (
            <div>
              <Badge tone="bad">Gone</Badge>
              <p className="mt-3 text-[22px] font-semibold tracking-[-0.02em]">
                The entity is no longer on Arkiv.
              </p>
              <p className="mt-1 text-ink-2">
                It wasn't renewed in time, or it was deleted.
              </p>
            </div>
          )
        ) : (
          <div>
            <div className="text-[13px] text-ink-2">
              Watching for new records matching
            </div>
            <p className="mt-2 font-mono text-[15px] break-all">
              {String(s.search)}
            </p>
          </div>
        )}
      </section>

      <Group title="Details">
        <Detail k="Type">
          <Badge tone={tone}>{name}</Badge>
        </Detail>
        {s.targetKey && (
          <Detail k="Entity">
            <Hash
              value={s.targetKey}
              href={`${EXPLORER}/entity/${s.targetKey}`}
            />
          </Detail>
        )}
        {target && (
          <Detail k="Owner">
            <Hash
              value={target.owner}
              href={`${EXPLORER}/address/${target.owner}`}
            />
          </Detail>
        )}
        <Detail k="Created by">
          <Hash value={s.creator} href={`${EXPLORER}/address/${s.creator}`} />
        </Detail>
        <Detail k="Runs until">
          <span className="tnum text-ink-2">
            Block {num(s.expiresAt)}, in {duration(s.expiresAt - head)}
          </span>
        </Detail>
        <Detail k="Who can renew it">
          <span className="text-ink-2">
            {s.publicMonitor ? "Anyone (public monitor)" : "Only its creator"}
          </span>
        </Detail>
        <Detail k="Subscription">
          <Hash value={subKey} href={`${EXPLORER}/entity/${subKey}`} />
        </Detail>
      </Group>
    </>
  );
}

function Detail({ k, children }: { k: string; children: ReactNode }) {
  return (
    <Row className="justify-between">
      <span className="shrink-0">{k}</span>
      <span className="min-w-0 text-right">{children}</span>
    </Row>
  );
}

function TargetClock({
  s,
  target,
  head,
}: {
  s: Sub;
  target: RawEntity;
  head: bigint;
}) {
  const left = useRemaining(target.expiresAt, head);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <div className="text-[13px] text-ink-2">
            {left > 0 ? "The entity expires in" : "The entity expires"}
          </div>
          <div className="mt-1 text-[48px] leading-none font-semibold tracking-[-0.035em] sm:text-[64px]">
            {left > 0 ? <Countdown ms={left} /> : "about now"}
          </div>
        </div>
        <div className="tnum pb-1 text-[13px] text-ink-2 sm:text-right">
          At block {num(target.expiresAt)}
        </div>
      </div>
      <div className="mt-6">
        <LiveRuler
          head={head}
          expiresAt={target.expiresAt}
          trigger={s.trigger}
          leadBlocks={s.leadBlocks}
          keepBlocks={s.keepBlocks}
        />
      </div>
    </>
  );
}
