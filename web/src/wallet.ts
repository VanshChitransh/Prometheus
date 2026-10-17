// The user's own signer (LLD §7 "Wallets"): MetaMask, or a key generated here and kept in this
// browser's localStorage. Either way the key never leaves the device; the page only asks it to sign.
import type { WalletArkivClient } from "@arkiv-network/sdk";
import { tiramisu } from "@arkiv-network/sdk/chains";
import { formatEther, toHex, type EIP1193Provider, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import {
  injectedWalletClient,
  publicHttp,
  walletClient,
} from "../../shared/arkiv.ts";

declare const __ARKIV_HTTP__: string; // vite.config.ts
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const RPC = __ARKIV_HTTP__;
const STORAGE_KEY = "prometheus.privateKey";

// Reads are free and need no wallet. No access key: the bundle is public.
export const reader = publicHttp(RPC);

export type Wallet = {
  kind: "metamask" | "local";
  address: Hex;
  client: WalletArkivClient;
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

// Reuses the stored key, or makes one. localStorage, not sessionStorage: reloading keeps it.
export function useLocalKey(): Wallet {
  let key = localStorage.getItem(STORAGE_KEY) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(STORAGE_KEY, key);
  }
  return (current = {
    kind: "local",
    address: privateKeyToAddress(key),
    client: walletClient(key, RPC) as WalletArkivClient,
  });
}

export const hasLocalKey = () => localStorage.getItem(STORAGE_KEY) !== null;
export const localKey = () => localStorage.getItem(STORAGE_KEY);

export const balance = async (address: Hex) =>
  formatEther(await reader.getBalance({ address }));
