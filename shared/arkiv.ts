// The only place that builds Arkiv clients (LLD §1). Browser-safe: callers pass URLs and keys in,
// so this file never imports config.ts.
import {
  createPublicClient,
  createWalletClient,
  type PublicArkivClient,
  type RpcEntity,
} from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { BaseError, checksumAddress, http, webSocket, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// retryCount 0: a 429 surfaces in seconds instead of viem silently honouring Retry-After (LLD §9).
const httpTransport = (url: string, accessKey?: string) =>
  http(url, {
    retryCount: 0,
    fetchOptions: accessKey
      ? { headers: { "X-API-KEY": accessKey } }
      : undefined,
  });

export const publicHttp = (url: string, accessKey?: string) =>
  createPublicClient({
    chain: tiramisu,
    transport: httpTransport(url, accessKey),
  });

// viem's default gives up after 5 reconnects. It also drops subscriptions on reconnect,
// which the stall timer in stream.ts handles (LLD §3.3). viem's webSocket can't send headers,
// so live events use the anonymous quota.
export const publicWs = (url: string) =>
  createPublicClient({
    chain: tiramisu,
    transport: webSocket(url, { reconnect: { attempts: Infinity } }),
  });

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

// Free filtered count. The SDK's getEntityCount() sends no query (chain-wide total);
// its getEntity()/query cost 100 units each (LLD §3.3).
export const freeCount = (client: PublicArkivClient, query: string) =>
  call<number>(client, "arkiv_getEntityCount", [{ query }]);

export type RawEntity = {
  key: Hex;
  creator: Hex;
  owner: Hex;
  expiresAt: bigint;
  flags: { readonly: boolean; permissionlessExtension: boolean };
  // u64 → bigint; i32 → number; bool → boolean; everything else (str, key, addr, u256…) a string.
  attributes: Record<string, string | number | boolean | bigint>;
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
  const flags =
    typeof e.creationFlags === "object" ? e.creationFlags : undefined;
  return {
    key: e.key!,
    // The node returns lowercase; checksum so === matches TRUSTED_WORKERS and the SDK's output.
    creator: checksumAddress(e.creator!),
    owner: checksumAddress(e.owner!),
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
    payload: e.payload,
  };
}
