// The keeper (LLD §3.6): extends a watched target before it lapses, only when that's safe and allowed,
// and records every outcome as a receipt. Receipts.fire has already claimed the trigger, waited out
// delay_blocks and checked no trusted worker acted, so this decides only *what* happens. Node only.
import type { PublicArkivClient } from "@arkiv-network/sdk";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { parseEther, type Hex } from "viem";
import { rawGetEntity } from "../shared/arkiv.ts";
import {
  DENY_LIST,
  KEEP_BUDGET_PER_DAY,
  PROJECT,
  type Event,
} from "../shared/schema.ts";
import { triggerId } from "../shared/triggerId.ts";
import type { Sub } from "../shared/subscription.ts";
import type { Targets } from "./expiry.ts";
import { receiptCreate, type Seen } from "./receipts.ts";
import type { Writer } from "./writer.ts";

// Below this the keeper stops spending: ~200 extends at ~25.5k gas and ~1 gwei, kept back so
// heartbeats and receipts can still be paid for (LLD §3.6).
const RESERVE = parseEther("0.005");

// undefined = kept: the extension and its `kept` receipt landed in one transaction.
// `event` = a receipt to write; `retry` = don't mark the trigger done, offer it again next head;
// `id` = write the receipt under this id instead of the trigger's.
export type KeepOutcome =
  | undefined
  | {
      event?: Extract<
        Event,
        "keep_skipped" | "keep_failed" | "keeper_low_funds"
      >;
      note?: string;
      seen?: Seen;
      retry?: true;
      id?: Hex;
    };

type KeepArgs = {
  sub: Sub;
  target: Hex;
  id: Hex;
  triggerBlock: bigint;
  head: bigint;
};

export class Keeper {
  readonly #writer: Writer;
  readonly #pub: PublicArkivClient;
  readonly #targets: Targets;
  readonly #address: Hex;
  // Keeps on one target run one after another, so the second sees the first's extension (and
  // skips as already_extended) instead of sending a redundant tx built on the same stale read.
  readonly #locks = new Map<Hex, Promise<unknown>>();
  readonly #lowFunds = new Set<Hex>(); // triggers already told "low funds" this episode
  readonly #budgetSkipped = new Set<Hex>(); // triggers already told "budget" today
  // Extends sent today (UTC): anyone can point a keep sub at any permissionless target, so without a
  // ceiling a few wallets could drain the worker's gas (audit M4).
  #budget = { day: "", spent: 0 };

  constructor(o: {
    writer: Writer;
    pub: PublicArkivClient;
    targets: Targets;
    address: Hex; // whose balance pays for extends
  }) {
    this.#writer = o.writer;
    this.#pub = o.pub;
    this.#targets = o.targets;
    this.#address = o.address;
  }

  // Throws only on a network failure, so fire() retries on a later head: a brief outage shouldn't
  // give up on keeping someone's record alive (and if the tx did land, the retry finds `kept`).
  keep(k: KeepArgs): Promise<KeepOutcome> {
    const key = k.target.toLowerCase() as Hex;
    const run = (this.#locks.get(key) ?? Promise.resolve()).then(() =>
      this.#keep(k),
    );
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    void tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }

  // A send that throws (network) gives its budget unit back: fire() offers the trigger again next
  // head, and each retry used to spend another unit, so one RPC flap could burn dozens. A refused
  // tx (ok: false) keeps it: it still cost gas.
  async #batch(p: Parameters<Writer["batch"]>[0]) {
    try {
      return await this.#writer.batch(p);
    } catch (e) {
      this.#budget.spent = Math.max(0, this.#budget.spent - 1);
      throw e;
    }
  }

  async #keep(k: KeepArgs): Promise<KeepOutcome> {
    const skip = (note: string, seen?: Seen) =>
      ({ event: "keep_skipped", note, seen }) as const;

    // Rule 2, free: creation flags never change, so the cache's copy is final.
    const cached = this.#targets.get(k.target);
    if (cached && !cached.flags.permissionlessExtension)
      return skip("not_permissionless", {
        creator: cached.creator,
        owner: cached.owner,
      });

    // One free read serves rules 3 and 4: the attributes, and the expiry as it is right now.
    const e = await rawGetEntity(this.#pub, k.target);
    // The cache still pins which entity we watched, even after it lapsed.
    if (!e)
      return skip(
        "already_expired",
        cached && { creator: cached.creator, owner: cached.owner },
      );
    const seen = { creator: e.creator, owner: e.owner };
    if (!e.flags.permissionlessExtension)
      return skip("not_permissionless", seen);
    // Rule 3. ponytail: a name heuristic (nothing on chain marks a canary); the owner's real
    // protection is creating it without permissionlessExtension (LLD §3.6, known limit).
    // Our own entities too: two public subscriptions keeping each other alive would never end.
    if (
      e.attributes.project === PROJECT ||
      DENY_LIST.test(`${e.attributes.kind ?? ""} ${e.attributes.project ?? ""}`)
    )
      return skip("deny_listed", seen);
    // Rule 4: someone already extended it past this trigger's window.
    const expSeen = e.expiresAt;
    if (expSeen > k.head + k.sub.leadBlocks!)
      return skip("already_extended", seen);

    // Below the reserve: say so once per trigger, under its own id (sharing the keep's id would make
    // the dedupe treat "low funds" as done), and keep offering the trigger so a refill still acts.
    if ((await this.#pub.getBalance({ address: this.#address })) < RESERVE) {
      if (this.#lowFunds.has(k.id)) return { retry: true };
      this.#lowFunds.add(k.id);
      const id = triggerId({
        subscription: k.sub.key,
        subject: k.target,
        event: "keeper_low_funds",
        triggerBlock: k.triggerBlock,
      });
      return { event: "keeper_low_funds", seen, retry: true, id };
    }
    this.#lowFunds.delete(k.id);

    // A spent budget is this worker's limit, not the trigger's outcome: like low funds, it gets its
    // own id and the trigger stays offered. Under the keep's id, the other worker's dedupe saw
    // "done" and never kept, so the target lapsed although that worker had budget (audit).
    const day = new Date().toISOString().slice(0, 10);
    if (this.#budget.day !== day) this.#budget = { day, spent: 0 };
    if (this.#budget.spent >= KEEP_BUDGET_PER_DAY) {
      if (this.#budgetSkipped.has(k.id)) return { retry: true };
      this.#budgetSkipped.add(k.id);
      const id = triggerId({
        subscription: k.sub.key,
        subject: k.target,
        event: "keep_skipped", // the keep's own id uses "keep": these never collide
        triggerBlock: k.triggerBlock,
      });
      return { ...skip("budget", seen), retry: true, id };
    }
    this.#budgetSkipped.delete(k.id);
    this.#budget.spent++; // counted when sent: a refused tx still costs gas

    // atBlock, not fromBlocks: A and B compute the same block, so a race sets an equal expiry
    // (a no-op on the node) instead of extending twice.
    const r = await this.#batch({
      extensions: [
        {
          entityKey: k.target,
          expires: ExpirationTime.atBlock(expSeen + k.sub.keepBlocks!),
        },
      ],
      creates: [
        receiptCreate({
          id: k.id,
          subscription: k.sub.key,
          subject: k.target,
          event: "kept",
          triggerBlock: k.triggerBlock,
          doneBlock: k.head,
          targetCreator: e.creator,
          targetOwner: e.owner,
        }),
      ],
    });
    if (r.ok) return undefined;
    // Refused by the chain (a decoded engine error; infrastructure trouble throws instead).
    if (r.errorName === "ExpiryNotExtended")
      return skip("already_extended", seen); // extended further between our read and the tx
    if (r.errorName === "EntityExpired" || r.errorName === "EntityNotFound")
      return skip("already_expired", seen); // lapsed between our read and the tx
    return { event: "keep_failed", note: r.reason.slice(0, 200), seen };
  }
}
