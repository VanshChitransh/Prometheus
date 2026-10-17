// POST /sponsor (LLD §6.1, §6.2): 0.02 GLM to a new user's in-browser wallet, so they can create a
// subscription without the faucet. It's free money, so every gate below exists to stop abuse:
// a real Telegram user (initData), one claim per user and per address, no top-ups for funded
// wallets, a 1 GLM / 24 h total cap, and one transfer at a time. Node only.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PublicArkivClient } from "@arkiv-network/sdk";
import { isAddress, parseEther, type Hex } from "viem";
import type { Db } from "./db.ts";

export const SPONSOR_AMOUNT = parseEther("0.02");
const FUNDED = parseEther("0.01"); // at or above this, the wallet doesn't need us
const DAILY_CAP = parseEther("1"); // ≈50 users / 24 h
const MAX_AGE_SEC = 3_600;
const MAX_SKEW_SEC = 60; // an auth_date further ahead than this is forged or a broken clock
const CONFIRM_TIMEOUT_MS = 60_000;
export const FAUCET = "https://hub.arkiv.network/faucet";

// Telegram Mini App initData, per core.telegram.org/bots/webapps ("Validating data received via
// the Mini App"): HMAC-SHA256 over every field except `hash`, sorted by key, as key=value lines,
// keyed by HMAC-SHA256(key "WebAppData", botToken). Only someone holding the bot token can sign it,
// so a valid hash proves Telegram handed this user to our Mini App.
// Returns the Telegram user id; "stale" for a genuine one over an hour old (the Mini App was left
// open), so the user can be told to reopen it; null for anything forged or malformed.
export function verifyInitData(
  initData: string,
  botToken: string,
  nowSec: number,
): number | "stale" | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");
  // Sorted by key, not by the whole line: "a1=" sorts before "a=", but key "a" comes before "a1".
  const check = [...params]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  // Constant time: === would leak, byte by byte, how much of a guessed hash is right.
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate - nowSec > MAX_SKEW_SEC)
    return null;
  if (nowSec - authDate > MAX_AGE_SEC) return "stale";
  try {
    const id: unknown = JSON.parse(params.get("user") ?? "").id;
    return Number.isSafeInteger(id) && (id as number) > 0
      ? (id as number)
      : null;
  } catch {
    return null;
  }
}

export type SponsorReply = { status: number; body: Record<string, unknown> };

export function createSponsor(o: {
  db: Db;
  pub: Pick<PublicArkivClient, "getBalance" | "waitForTransactionReceipt">;
  send: (to: Hex, value: bigint) => Promise<Hex>; // broadcasts one transfer, returns its hash
  botToken: string;
  now?: () => number; // ms, like Date.now; tests pass a fake clock
  confirmMs?: number; // how long a transfer holds the queue; tests shorten it
}) {
  const now = o.now ?? Date.now;
  const confirmMs = o.confirmMs ?? CONFIRM_TIMEOUT_MS;
  let chain: Promise<unknown> = Promise.resolve();

  // One transfer at a time, each mined (or timed out) before the next starts: viem reads the
  // pending nonce on every send, so two in flight could pick the same one. Resolves with the hash
  // as soon as it's broadcast; the user doesn't wait for the block.
  const transfer = (to: Hex) => {
    const sent = chain.then(() => o.send(to, SPONSOR_AMOUNT));
    chain = sent.then(
      async (hash) => {
        const start = Date.now();
        await o.pub
          .waitForTransactionReceipt({ hash, timeout: confirmMs })
          .catch(async (e) => {
            console.error(`[sponsor] ${hash} not confirmed:`, e);
            // An RPC error (retryCount 0: one 429) ends the wait at once, with the transfer maybe
            // still unmined: hold the queue for the rest of the window anyway (audit RL-5).
            const left = confirmMs - (Date.now() - start);
            await new Promise((r) => setTimeout(r, left));
          });
      },
      () => {}, // a failed send is the caller's to report; the next one may go ahead
    );
    return sent;
  };

  const fail = (status: number, error: string): SponsorReply => ({
    status,
    body: { error },
  });
  // For the refusals waiting won't fix: a transfer that never landed, or an empty sponsor wallet.
  const faucet = (status: number, error: string): SponsorReply => ({
    status,
    body: { error: `${error} Need GLM? Use the faucet.`, faucet: FAUCET },
  });
  const capped = () => o.db.sponsoredLast24h() + SPONSOR_AMOUNT > DAILY_CAP;
  const usedUp: SponsorReply = {
    status: 429,
    body: {
      error: "Today's free GLM is used up. Try the faucet.",
      faucet: FAUCET,
    },
  };

  // Throws only if the balance lookup fails (the caller answers 500); nothing is claimed by then.
  return async function handle(body: unknown): Promise<SponsorReply> {
    const { address, initData } = (body ?? {}) as Record<string, unknown>;
    if (typeof address !== "string" || typeof initData !== "string")
      return fail(400, "Send { address, initData }.");
    const user = verifyInitData(initData, o.botToken, Math.floor(now() / 1000));
    if (user === "stale")
      return fail(
        401,
        "This Telegram session is over an hour old. Close Prometheus and open it again from the bot.",
      );
    if (user === null)
      return fail(401, "Open this from the Prometheus Telegram bot.");
    if (!isAddress(address)) return fail(400, "That isn't a valid address.");

    // Refusals that need no RPC come first, so a sponsored user or a spent cap can't make every
    // request cost a balance lookup on the key delivery shares (audit RL-4).
    if (o.db.isSponsored(user, address))
      return faucet(409, "You've already been sponsored.");
    if (capped()) return usedUp;
    if ((await o.pub.getBalance({ address })) >= FUNDED)
      return fail(409, "This wallet already has GLM.");
    // No await from here to the claim: Node can't run another request in between, so two taps at
    // once can't both pass the cap check.
    if (capped()) return usedUp;
    // The row is written BEFORE any GLM moves: its keys block a second grant (LLD §6.1).
    if (!o.db.claimSponsor(user, address, SPONSOR_AMOUNT))
      return faucet(409, "You've already been sponsored.");

    let tx: Hex;
    try {
      tx = await transfer(address);
    } catch (e) {
      // ponytail: any throw counts as "never broadcast" and frees the claim for a retry. If the node
      // took the tx but the reply was lost, this user could claim twice: 0.02 GLM, still under the
      // daily cap. Check by nonce before releasing if that ever matters.
      o.db.releaseSponsor(user);
      console.error("[sponsor] send failed:", e);
      return faucet(503, "Couldn't send GLM right now. Try again later.");
    }
    o.db.recordSponsorTx(user, tx);
    return { status: 200, body: { tx } };
  };
}
