// The user's own signer (LLD §7 "Wallets"): MetaMask, or a key generated here and kept on this device
// (localStorage on the web, Telegram's SecureStorage in the Mini App). Either way the key never leaves
// the device; the page only asks it to sign.
import type { WalletArkivClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { formatEther, toHex, type EIP1193Provider, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import {
  injectedWalletClient,
  publicHttp,
  walletClient,
} from "../../shared/arkiv.ts";
import { keyStore, sponsorResult, tg, type KeyStore } from "./telegram.ts";

declare const __ARKIV_HTTP__: string; // vite.config.ts
declare const __RELAY_URL__: string; // vite.config.ts; "" = no relay, so no free GLM
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const RPC = __ARKIV_HTTP__;

// Reads are free and need no wallet. No access key: the bundle is public.
export const reader = publicHttp(RPC);

export type Wallet = {
  kind: "metamask" | "local";
  address: Hex;
  client: WalletArkivClient;
  storage?: KeyStore["where"]; // local keys only
};

let current: Wallet | undefined;
export const wallet = () => current;

export async function connectMetaMask(): Promise<Wallet> {
  const eth = window.ethereum;
  if (!eth)
    throw new Error(
      "No browser wallet found. Install MetaMask, or make a key in this browser.",
    );
  const [address] = await eth.request({ method: "eth_requestAccounts" });
  if (!address) throw new Error("MetaMask shared no account.");
  // Adds Tiramisu if missing, then asks to switch to it.
  await eth.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: toHex(tiramisu.id),
        chainName: tiramisu.name,
        nativeCurrency: tiramisu.nativeCurrency,
        rpcUrls: [RPC],
      },
    ],
  });
  // A different account would leave this page signing as the old address.
  eth.on("accountsChanged", () => location.reload());
  return (current = {
    kind: "metamask",
    address,
    client: injectedWalletClient(eth, address) as WalletArkivClient,
  });
}

// Reuses the stored key, or makes one. Persistent storage, so reopening the page keeps it.
export async function useLocalKey(): Promise<Wallet> {
  const store = await keyStore();
  let key = (await store.get()) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    await store.set(key);
  }
  return (current = {
    kind: "local",
    address: privateKeyToAddress(key),
    client: walletClient(key, RPC) as WalletArkivClient,
    storage: store.where,
  });
}

export const storedKey = async () => (await keyStore()).get();

export const balance = (address: Hex) => reader.getBalance({ address });
export const glm = (wei: bigint) => `${formatEther(wei)} GLM`;

// Free starter GLM from the relay (LLD §6.2): only inside Telegram, whose signed initData proves a
// real user. Resolves once the transfer is mined, so the new balance shows straight away.
export const canSponsor = () => !!tg && !!__RELAY_URL__;
export async function requestSponsor(address: Hex) {
  const res = await fetch(`${__RELAY_URL__.replace(/\/$/, "")}/sponsor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, initData: tg!.initData }),
  });
  const r = sponsorResult(res.status, await res.json().catch(() => ({})));
  if (!r.ok) throw new Error(r.text);
  await reader.waitForTransactionReceipt({ hash: r.tx, timeout: 60_000 });
}
