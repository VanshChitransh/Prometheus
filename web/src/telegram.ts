// Telegram Mini App glue (LLD §7 "Wallets"). One bundle: on the plain web `tg` is undefined and
// nothing here changes behaviour. Inside Telegram it routes the launch link, keeps the wallet key in
// Telegram's on-device storage, and opens t.me links without leaving the app.
import type { Hex } from "viem";
import { decodeKey } from "../../shared/deeplink.ts";
import { link } from "./router.ts";

// Only the parts we use (core.telegram.org/bots/webapps). Storage callbacks are (error, value…).
type TgStorage = {
  getItem(
    key: string,
    cb: (err: unknown, value?: string | null, canRestore?: boolean) => void,
  ): void;
  setItem(key: string, value: string, cb?: (err: unknown) => void): void;
  restoreItem?(
    key: string,
    cb?: (err: unknown, value?: string | null) => void,
  ): void;
};
type WebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string };
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  openTelegramLink(url: string): void;
  SecureStorage?: TgStorage; // Bot API 9.0, iOS Keychain / Android Keystore
  DeviceStorage?: TgStorage; // Bot API 9.0, local key-value storage
};
declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

// Set only inside Telegram: telegram-web-app.js also loads on the plain web, with empty initData.
// globalThis.window, not window: tests import this file under Node.
const app = (globalThis as { window?: Window }).window?.Telegram?.WebApp;
export const tg = app?.initData ? app : undefined;

// The hash to open at launch. Telegram appends #tgWebAppData=… to our URL, which the router can't
// read; and t.me/<bot>?startapp=<encoded key> means "open that subscription's status page".
export function launchHash(hash: string, startParam?: string) {
  const key = startParam ? decodeKey(startParam) : null;
  if (key) return `#/s/${key}`;
  return hash === "" || hash.startsWith("#tgWebApp") ? "#/" : hash;
}

// Before the router starts. telegram-web-app.js (loaded first, in <head>) has already read the hash.
export function boot() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  const h = launchHash(location.hash, tg.initDataUnsafe.start_param);
  if (h !== location.hash) history.replaceState(null, "", h);
}

// --- where the generated key lives ---

const KEY = "prometheus.privateKey";

export type KeyStore = {
  where: "browser" | "telegram-secure" | "telegram-device";
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
};

const browserStore: KeyStore = {
  where: "browser",
  get: async () => localStorage.getItem(KEY),
  set: async (v) => localStorage.setItem(KEY, v),
};

function tgStore(s: TgStorage, where: KeyStore["where"]): KeyStore {
  return {
    where,
    get: () =>
      new Promise((resolve, reject) =>
        s.getItem(KEY, (err, value, canRestore) => {
          if (err) return reject(err);
          if (value || !canRestore || !s.restoreItem)
            return resolve(value ?? null);
          // A reinstall keeps a SecureStorage item restorable: Telegram asks the user first.
          s.restoreItem(KEY, (e, restored) =>
            resolve(e ? null : (restored ?? null)),
          );
        }),
      ),
    set: (value) =>
      new Promise((resolve, reject) =>
        s.setItem(KEY, value, (err) => (err ? reject(err) : resolve())),
      ),
  };
}

// SecureStorage where the platform has it (iOS, Android); Telegram Desktop and Web refuse it, so
// DeviceStorage there; older Telegram clients get the webview's localStorage.
async function pick(): Promise<KeyStore> {
  if (!tg?.isVersionAtLeast("9.0")) return browserStore;
  if (tg.SecureStorage) {
    const s = tg.SecureStorage;
    // Probe with a key we never write, so the probe can't trigger a restore prompt. A client that
    // never answers would hang the page before its first render, so give up after 3 s.
    const works = await new Promise<boolean>((r) => {
      setTimeout(() => r(false), 3_000);
      s.getItem("prometheus.probe", (err) => r(!err));
    });
    if (works) return tgStore(s, "telegram-secure");
  }
  return tg.DeviceStorage
    ? tgStore(tg.DeviceStorage, "telegram-device")
    : browserStore;
}

let chosen: Promise<KeyStore> | undefined;
export const keyStore = () => (chosen ??= pick());

// --- links and the /sponsor reply ---

// A t.me link that stays inside Telegram (and keeps the Mini App open); a plain link elsewhere.
export function telegramLink(href: string, text: string) {
  const a = link(href, text);
  if (tg)
    a.onclick = (e) => {
      e.preventDefault();
      tg.openTelegramLink(href);
    };
  return a;
}

export const FAUCET = "https://hub.arkiv.network/faucet";

// The relay's replies already carry user-facing text (relay/sponsor.ts); this only sorts them.
export function sponsorResult(
  status: number,
  body: { tx?: unknown; error?: unknown },
): { ok: true; tx: Hex } | { ok: false; text: string } {
  if (
    status === 200 &&
    typeof body.tx === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(body.tx)
  )
    return { ok: true, tx: body.tx as Hex };
  return {
    ok: false,
    text:
      typeof body.error === "string"
        ? body.error
        : `The relay couldn't send GLM (${status}).`,
  };
}
