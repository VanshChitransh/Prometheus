// The only place that builds Arkiv clients (LLD §1). Browser-safe: callers pass URLs and keys in,
// so this file never imports config.ts.
import {
  createPublicClient,
  createWalletClient,
  decodeCreationFlags,
  type PublicArkivClient,
  type RpcEntity,
} from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import {
  BaseError,
  checksumAddress,
  custom,
  http,
  publicActions,
  webSocket,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// retryCount 0: a 429 surfaces in seconds instead of viem silently honouring Retry-After (LLD §9).
const httpTransport = (url: string, accessKey?: string) =>
  http(url, {
    retryCount: 0,
    fetchOptions: accessKey
      ? { headers: { "X-API-KEY": accessKey } }
      : undefined,
  });

// cacheTime 0: the chain sets no blockTime, so viem held getBlockNumber() for 4 s (~2 blocks) and
// "has the HTTP node reached this block?" polls kept reading a stale head. Here only, not on the
// chain: that would also make the wallet poll for receipts 4× as often.
export const publicHttp = (url: string, accessKey?: string) =>
  createPublicClient({
    chain: tiramisu,
    cacheTime: 0,
    transport: httpTransport(url, accessKey),
  });

// viem's default gives up after 5 reconnects. It restores subscriptions on reconnect but doesn't
// backfill the gap; stream.ts replays it (LLD §3.3). viem's webSocket can't send headers,
// so live events use the anonymous quota. The SDK adds all of viem's public actions at runtime but
// types only a subset; re-extending types watchBlockNumber (the heads stream) without changing behaviour.
export const publicWs = (url: string) =>
  createPublicClient({
    chain: tiramisu,
    transport: webSocket(url, { reconnect: { attempts: Infinity } }),
  }).extend(publicActions);

// No retries here either: retrying a write is writer.ts's job, because it owns the nonce.
export const walletClient = (
  privateKey: Hex,
  url: string,
  accessKey?: string,
) =>
  createWalletClient({
    chain: tiramisu,
    transport: httpTransport(url, accessKey),
    account: privateKeyToAccount(privateKey),
  });

// A browser wallet (MetaMask) holds the key and signs; the page only knows the address.
export const injectedWalletClient = (provider: EIP1193Provider, address: Hex) =>
  createWalletClient({
    chain: tiramisu,
    transport: custom(provider),
    account: address,
  });

// `code` is the JSON-RPC error code (e.g. -32602) or, for HTTP failures, the status (e.g. 429).
export class RpcError extends Error {
  readonly method: string;
  readonly code: number;
  constructor(method: string, code: number, options: { cause: unknown }) {
    super(`${method} failed (${code})`, options);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
  }
}

// Raw JSON-RPC for the two free methods the SDK lacks. The cast is needed because the SDK types
// arkiv_getEntityCount as taking no params and leave arkiv_getEntity out (arkiv/friction.md).
async function call<T>(
  client: PublicArkivClient,
  method: string,
  params: unknown[],
) {
  const request = client.request as unknown as (args: {
    method: string;
    params: unknown[];
  }) => Promise<T>;
  try {
    return await request({ method, params });
  } catch (e) {
    throw new RpcError(method, rpcCode(e), { cause: e });
  }
}

// The JSON-RPC code or HTTP status buried in any viem error chain (or an RpcError); -1 if none.
export function rpcCode(e: unknown): number {
  if (e instanceof RpcError) return e.code;
  const hit =
    e instanceof BaseError
      ? (e.walk(
          (x) =>
            typeof (x as { code?: unknown }).code === "number" ||
            typeof (x as { status?: unknown }).status === "number",
        ) as { code?: number; status?: number } | null)
      : null;
  return hit?.code ?? hit?.status ?? -1;
}

// The $creator clause every receipt query needs: anyone can compute a trigger_id, so only receipts
// from these wallets count (arkiv/schema.md, "TRUSTED").
export function trustedFilter(workers: readonly Hex[]) {
  if (workers.length === 0) throw new Error("no trusted workers");
  return `(${workers.map((a) => `$creator = addr(${a})`).join(" OR ")})`;
}

// Free filtered count. The SDK's getEntityCount() sends no query (chain-wide total);
// its getEntity()/query cost 100 units each (LLD §3.3).
export const freeCount = (client: PublicArkivClient, query: string) =>
  call<number>(client, "arkiv_getEntityCount", [{ query }]);

export type RawEntity = {
  key: Hex;
  creator: Hex;
  owner: Hex;
  createdAt: bigint; // creation block: orders the per-creator cap
  expiresAt: bigint;
  flags: { readonly: boolean; permissionlessExtension: boolean };
  // u64 → bigint; i32 → number; bool → boolean; everything else (str, key, addr, u256…) a string.
  attributes: Record<string, string | number | boolean | bigint>;
  // Each attribute's Arkiv type (str, key, addr…), which the values above can't tell apart.
  types?: Record<string, string>;
  payload?: Hex;
};

// Free read by key. null = no live entity (never created, deleted or expired), measured 16 Oct.
// Our own decoder: the SDK's entityFromRpcResult isn't exported.
export async function rawGetEntity(
  client: PublicArkivClient,
  key: Hex,
): Promise<RawEntity | null> {
  const e = await call<RpcEntity | null>(client, "arkiv_getEntity", [key]);
  if (!e) return null;
  // The byte first, like the SDK's own decoder: the node sends {readonly, permissionlessExtension,
  // raw} today, but RpcEntity also allows the bare byte or {raw}, which read as "no flags" (SH-7).
  const f = e.creationFlags;
  const raw = typeof f === "number" ? f : f?.raw;
  const flags =
    typeof raw === "number"
      ? decodeCreationFlags(raw)
      : typeof f === "object"
        ? f
        : undefined;
  return {
    key: e.key!,
    // The node returns lowercase; checksum so === matches TRUSTED_WORKERS and the SDK's output.
    creator: checksumAddress(e.creator!),
    owner: checksumAddress(e.owner!),
    createdAt: BigInt(e.createdAt!),
    expiresAt: BigInt(e.expiresAt!),
    flags: {
      readonly: flags?.readonly ?? false,
      permissionlessExtension: flags?.permissionlessExtension ?? false,
    },
    attributes: Object.fromEntries(
      (e.attributes ?? []).map((a) => [
        a.name,
        a.type === "u64"
          ? BigInt(a.value as string)
          : (a.value as string | number | boolean),
      ]),
    ),
    types: Object.fromEntries(
      (e.attributes ?? []).map((a) => [a.name, a.type]),
    ),
    payload: e.payload,
  };
}
