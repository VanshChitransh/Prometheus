// The only path to the wallet (LLD §3.5b). Heartbeat, receipts and keeper share one wallet, so every
// write waits in one line: one transaction in flight, with a nonce we count ourselves. viem's
// nonceManager burns a nonce when gas estimation reverts, which freezes the wallet (LLD §9).
// ponytail: one queue, one wallet; split keeper onto its own wallet if keeps starve receipts
import type {
  CreateEntityParameters,
  ExecuteBatchParameters,
  ExtendEntityParameters,
  TxParams,
} from "@arkiv-network/sdk";
import { engineRevert } from "./errors.ts";
// The SDK's wallet type omits the public actions it adds at runtime; viem's standalone action is typed.
import { getTransactionCount } from "viem/actions";
import type { walletClient } from "../shared/arkiv.ts";

type Wallet = ReturnType<typeof walletClient>;

// ok:false = the chain refused the write itself (e.g. extending an expired target): retrying won't help.
// errorName is the engine's (EntityExpired, ExpiryNotExtended, …): branch on it, not on the text.
export type WriteResult<T> =
  { ok: true; value: T } | { ok: false; errorName: string; reason: string };

export class Writer {
  readonly #wallet: Wallet;
  #nonce: number | undefined; // undefined = ask the chain before the next send
  #tail: Promise<unknown> = Promise.resolve();

  constructor(wallet: Wallet) {
    this.#wallet = wallet;
  }

  create(p: CreateEntityParameters) {
    return this.#enqueue((tx) => this.#wallet.createEntity(p, tx));
  }

  extend(p: ExtendEntityParameters) {
    return this.#enqueue((tx) => this.#wallet.extendEntity(p, tx));
  }

  batch(p: ExecuteBatchParameters) {
    return this.#enqueue((tx) => this.#wallet.executeBatch(p, tx));
  }

  // Each write starts only after the previous one settles. A network failure throws to the caller,
  // who decides on backoff.
  #enqueue<T>(write: (tx: TxParams) => Promise<T>): Promise<WriteResult<T>> {
    const run = this.#tail.then(() => this.#send(write));
    this.#tail = run.catch(() => {}); // a failed write must not block the ones behind it
    return run;
  }

  async #send<T>(write: (tx: TxParams) => Promise<T>): Promise<WriteResult<T>> {
    try {
      // "pending" counts our own txs still waiting to be mined.
      const nonce = (this.#nonce ??= await getTransactionCount(this.#wallet, {
        address: this.#wallet.account.address,
        blockTag: "pending",
      }));
      const value = await write({ nonce });
      this.#nonce = nonce + 1;
      return { ok: true, value };
    } catch (e) {
      // After any failure our count may be wrong (the tx may or may not have left): re-read it.
      this.#nonce = undefined;
      const revert = engineRevert(e);
      if (revert) return { ok: false, ...revert };
      throw e;
    }
  }
}
