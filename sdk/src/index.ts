// prometheus-arkiv: create, check, renew, cancel and read Prometheus subscriptions from code.
// Every create runs the same checks as the web app's /new before anything is signed.
import type { PublicArkivClient, WalletArkivClient } from "@arkiv-network/sdk";
import { addr, key } from "@arkiv-network/sdk/attr";
import { eq, MAX_LIMIT, or, type Expression } from "@arkiv-network/sdk/query";
import { ExpirationTime } from "@arkiv-network/sdk/utils";
import { getAddress, type Hex } from "viem";
import {
  freeCount,
  publicHttp,
  rawGetEntity,
  type RawEntity,
} from "../../shared/arkiv.ts";
import { encodeKey } from "../../shared/deeplink.ts";
import { inBatches } from "../../shared/limit.ts";
import { parseReceipt, type Receipt } from "../../shared/receipt.ts";
import { BOUNDS, PROJECT, type Trigger } from "../../shared/schema.ts";
import {
  decodeSubscription,
  keepBlocked,
  type Sub,
} from "../../shared/subscription.ts";
import { span } from "../../web/src/entityForm.ts";
import {
  blocksOf,
  build,
  PrometheusError,
  type Duration,
  type Input,
  type Where,
} from "./build.ts";

export { LIMITS, PrometheusError } from "./build.ts";
export type { Duration, ErrorCode, Where } from "./build.ts";
export { TRIGGERS, type Trigger } from "../../shared/schema.ts";
export type { Receipt } from "../../shared/receipt.ts";
/** A subscription as workers decode it. */
export type Subscription = Sub;

const TIRAMISU_RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
const DEFAULT_TRUSTED_WORKERS: readonly Hex[] = [
  "0x6a693Fd642c1F8F5E78321C2722208A3791eE79B",
  "0xa70C8245582d173b04cAe453E9fF6D17a6e58294",
];

export type PrometheusOptions = {
  /** Signs every create, renew and cancel. */
  wallet: WalletArkivClient;
  /** For reads. Default: the wallet, if it has public actions, else a Tiramisu client. */
  publicClient?: PublicArkivClient;
  /** The Prometheus web app, e.g. "https://prometheus.example". Adds `statusUrl` to results. */
  site?: string;
  /** Default "prometheus_arkiv_bot". */
  botName?: string;
  /** Only receipts created by these wallets count. Default: worker A and worker B. */
  trustedWorkers?: readonly string[];
};

export type WatchOptions = {
  /** Shown in every alert. 1–80 characters. */
  label: string;
  /** How long the subscription runs. Default "7d". */
  for?: Duration;
  /** Anyone may renew this subscription, not just you. Default false. */
  public?: boolean;
};
export type ExpiringOptions = WatchOptions & {
  /** Warn this long before the target expires: 1m to 1d. */
  before: Duration;
};
export type KeepOptions = WatchOptions & {
  /** Renew this long before the target expires: 1m to 1d. */
  before: Duration;
  /** Add this much each time: 1h to 30d, and more than `before`. */
  extendBy: Duration;
};
export type NewMatchOptions = WatchOptions & {
  /** Equality conditions on the new entity's attributes. */
  where: Where;
  /** Only entities created by this address. */
  createdBy?: Hex;
};

export type WatchResult = {
  /** The subscription key. */
  key: Hex;
  txHash: Hex;
  /** Open it and tap Start to get the alerts in Telegram. Shareable. */
  telegramUrl: string;
  /** The status page, when `site` is set. */
  statusUrl?: string;
  /** Warnings that don't stop the create, e.g. the subscription ends before the target expires. */
  notes: string[];
};
export type CheckResult =
  | { ok: true; notes: string[] }
  | { ok: false; code: PrometheusError["code"]; reason: string };

const KEY = /^0x[0-9a-fA-F]{64}$/;
const keyOf = (k: unknown) => {
  if (typeof k !== "string" || !KEY.test(k))
    throw new PrometheusError(
      "bad_key",
      "Pass a subscription key: 0x followed by 64 hex characters.",
    );
  return k as Hex;
};

const KEEP_BLOCKED = {
  not_permissionless:
    "Its creator didn't allow anyone else to renew it (permissionlessExtension), so every renewal would be skipped.",
  deny_listed:
    "It looks like a canary or heartbeat (or is a Prometheus entity), so every renewal would be skipped.",
};

// One method per trigger, shared by `watch` (signs) and `check` (doesn't).
const triggers = <R>(run: (trigger: Trigger, input: Input) => Promise<R>) => ({
  expiring: (target: Hex, o: ExpiringOptions) =>
    run("expiring", { ...o, target }),
  expired: (target: Hex, o: WatchOptions) => run("expired", { ...o, target }),
  changed: (target: Hex, o: WatchOptions) => run("changed", { ...o, target }),
  keep: (target: Hex, o: KeepOptions) => run("keep", { ...o, target }),
  newMatch: (o: NewMatchOptions) => run("new_match", o),
});

export class Prometheus {
  readonly #wallet: WalletArkivClient;
  readonly #reader: PublicArkivClient;
  readonly #site?: string;
  readonly #bot: string;
  readonly #trusted: Hex[];

  /** Create a subscription, signed by the wallet. Throws PrometheusError and signs nothing if a check fails. */
  readonly watch = triggers((t, i) => this.#create(t, i));
  /** Run every check `watch` runs, without signing. */
  readonly check = triggers(async (t, i): Promise<CheckResult> =>
    this.#prepare(t, i).then(
      ({ notes }) => ({ ok: true, notes }),
      (e) => {
        if (!(e instanceof PrometheusError)) throw e; // network trouble isn't a verdict
        return { ok: false, code: e.code, reason: e.message };
      },
    ),
  );

  constructor(o: PrometheusOptions) {
    this.#wallet = o.wallet;
    const w = o.wallet as unknown as Partial<PublicArkivClient>;
    this.#reader =
      o.publicClient ??
      (typeof w.select === "function" && typeof w.getBalance === "function"
        ? (w as PublicArkivClient)
        : publicHttp(TIRAMISU_RPC));
    this.#site = o.site?.replace(/\/+$/, "");
    this.#bot = o.botName ?? "prometheus_arkiv_bot";
    // Checksummed, like rawGetEntity's creators, so parseReceipt's includes() matches.
    this.#trusted = (o.trustedWorkers ?? DEFAULT_TRUSTED_WORKERS).map((a) =>
      getAddress(a),
    );
    if (!this.#trusted.length) throw new Error("trustedWorkers is empty");
  }

  #address(): Hex {
    const a = this.#wallet.account?.address;
    if (!a)
      throw new PrometheusError(
        "no_account",
        "The wallet client has no account. Create it with `account`.",
      );
    return getAddress(a); // a browser wallet may report it lowercase
  }

  // Everything /new checks, in its order. Free reads only.
  async #prepare(trigger: Trigger, input: Input) {
    const creator = this.#address();
    const { params, lead, term } = build(trigger, input, creator);
    const r = this.#reader;
    const [head, target, live, balance] = await Promise.all([
      r.getBlockNumber(),
      trigger === "new_match"
        ? undefined
        : rawGetEntity(r, input.target as Hex),
      freeCount(
        r,
        `project = str('${PROJECT}') AND kind = str('subscription') AND $creator = addr(${creator})`,
      ),
      r.getBalance({ address: creator }),
    ]);
    // An expired trigger's target may already be gone (it then fires at once if that was within a day).
    if (target === null && trigger !== "expired")
      throw new PrometheusError(
        "target_not_found",
        "No live entity has that key. It may have expired already.",
      );
    const blocked = trigger === "keep" && keepBlocked(target!);
    if (blocked)
      throw new PrometheusError("keep_blocked", KEEP_BLOCKED[blocked]);
    // The worker ignores a creator's subscriptions past the cap, newest first: it would never fire.
    if (live >= BOUNDS.subsPerCreator)
      throw new PrometheusError(
        "too_many_subscriptions",
        `This wallet already has ${live} live subscriptions, and workers serve only the oldest ${BOUNDS.subsPerCreator}. Cancel one first.`,
      );
    if (balance === 0n)
      throw new PrometheusError(
        "no_funds",
        "This wallet has no GLM, and creating a subscription costs gas. Get testnet GLM at https://hub.arkiv.network/faucet.",
      );

    const notes: string[] = [];
    if (target) {
      const left = target.expiresAt - head;
      if (trigger === "expiring" && lead >= left)
        notes.push(
          "It expires sooner than `before`, so the warning comes right away.",
        );
      if (trigger !== "changed" && term < left)
        notes.push(
          `The subscription ends before the entity expires (in ${span(left)}). Pass a longer \`for\`.`,
        );
    }
    return { params, notes };
  }

  async #create(trigger: Trigger, input: Input): Promise<WatchResult> {
    const { params, notes } = await this.#prepare(trigger, input);
    const { entityKey, txHash } = await this.#wallet.createEntity(params);
    return {
      key: entityKey,
      txHash,
      telegramUrl: `https://t.me/${this.#bot}?start=${encodeKey(entityKey)}`,
      ...(this.#site && { statusUrl: `${this.#site}/s/${entityKey}` }),
      notes,
    };
  }

  // The live entity behind a key the wallet may change, or a PrometheusError saying why not.
  async #mine(k: unknown, renewing: boolean) {
    const e = await rawGetEntity(this.#reader, keyOf(k));
    if (!e)
      throw new PrometheusError(
        "not_found",
        "No live subscription has that key. It has ended, was cancelled, or never existed.",
      );
    if (
      e.owner !== this.#address() &&
      !(renewing && e.flags.permissionlessExtension)
    )
      throw new PrometheusError(
        "not_owner",
        `Only its owner, ${e.owner}, can ${renewing ? "renew" : "cancel"} it.`,
      );
    return e;
  }

  /** Run the subscription for `duration` from now. A renewal doesn't add to the time left. */
  async renew(subscriptionKey: Hex, duration: Duration) {
    const blocks = blocksOf(duration, "duration");
    const [e, head] = await Promise.all([
      this.#mine(subscriptionKey, true),
      this.#reader.getBlockNumber(),
    ]);
    if (head + blocks <= e.expiresAt)
      throw new PrometheusError(
        "renew_too_short",
        `It already runs ${span(e.expiresAt - head)} more. A renewal counts from now, so pass a longer duration.`,
      );
    const { txHash, expiresAt } = await this.#wallet.extendEntity({
      entityKey: e.key,
      expires: ExpirationTime.fromBlocks(Number(blocks)),
    });
    return { txHash, expiresAt };
  }

  /** Delete the subscription. Workers stop at once; its receipts stay readable. */
  async cancel(subscriptionKey: Hex) {
    const e = await this.#mine(subscriptionKey, false);
    const { txHash } = await this.#wallet.deleteEntity({ entityKey: e.key });
    return { txHash };
  }

  /** The subscription as workers decode it, or null if it has ended. */
  async get(subscriptionKey: Hex): Promise<Subscription | null> {
    const e = await rawGetEntity(this.#reader, keyOf(subscriptionKey));
    if (!e) return null;
    const d = decodeSubscription(e);
    if (!d.ok)
      throw new PrometheusError(
        "rejected",
        `Workers reject this subscription: ${d.reason}.`,
      );
    return d.sub;
  }

  /** Receipts written by trusted workers for this subscription, newest first. */
  async receipts(subscriptionKey: Hex): Promise<Receipt[]> {
    const entities = await this.#fetchAll(
      eq("kind", "receipt"),
      or(this.#trusted.map((a) => eq("$creator", addr(a)))),
      eq("subscription", key(keyOf(subscriptionKey))),
    );
    return entities
      .map((e) => parseReceipt(e, this.#trusted))
      .filter((r) => r !== null)
      .sort((a, b) => (a.triggerBlock < b.triggerBlock ? 1 : -1));
  }

  // Same as web/src/receipts.ts's fetchEntities: one paid query per page of keys, then a free read
  // per key, so we decode exactly what the workers decode.
  async #fetchAll(...where: Expression[]) {
    let page = await this.#reader
      .select({ key: true })
      .where(eq("project", PROJECT), ...where)
      .limit(MAX_LIMIT)
      .fetch();
    const out: RawEntity[] = [];
    for (;;) {
      const entities = await inBatches(page.entities, (e) =>
        rawGetEntity(this.#reader, e.key),
      );
      for (const e of entities) if (e) out.push(e); // null: expired between the query and the read
      if (!page.hasNextPage()) break;
      page = await page.next();
    }
    return out;
  }
}
