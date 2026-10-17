// Entity key ↔ Telegram /start payload (LLD §6.3). The payload is capped at 64 chars and a key is 66
// (0x + 64 hex), so the 32 bytes travel as unpadded base64url: 43 chars. Browser-safe: btoa/atob
// work in both runtimes, where Buffer is Node-only and Uint8Array.fromBase64 is missing on Node 24.

import { bytesToHex, hexToBytes, type Hex } from "viem";

const KEY = /^0x[0-9a-fA-F]{64}$/;
const PAYLOAD = /^[A-Za-z0-9_-]{43}$/;

export function encodeKey(key: Hex): string {
  if (!KEY.test(key)) throw new Error("encodeKey needs a 32-byte 0x key");
  return btoa(String.fromCharCode(...hexToBytes(key)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Lowercase hex (as relay/db.ts stores keys), or null for anything that isn't our exact encoding.
// Re-encoding catches the 4 spellings that differ only in the last char's 2 unused bits.
export function decodeKey(payload: string): Hex | null {
  if (!PAYLOAD.test(payload)) return null;
  const bin = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const key = bytesToHex(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  return encodeKey(key) === payload ? key : null;
}
