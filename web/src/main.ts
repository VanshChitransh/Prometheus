// Entry: the wallet bar in the header, and the page router below it. The same bundle runs as the
// Telegram Mini App (telegram.ts).
import { coveragePage } from "./pages/coverage.ts";
import { minePage } from "./pages/mine.ts";
import { newPage } from "./pages/new.ts";
import { statusPage } from "./pages/status.ts";
import { errorLine, link, p, startRouter } from "./router.ts";
import { boot, FAUCET, tg } from "./telegram.ts";
import {
  balance,
  canSponsor,
  connectMetaMask,
  glm,
  requestSponsor,
  storedKey,
  useLocalKey,
  wallet,
  type Wallet,
} from "./wallet.ts";

const bar = document.querySelector<HTMLElement>("#wallet")!;
const app = document.querySelector<HTMLElement>("#app")!;

function button(text: string, onClick: (b: HTMLButtonElement) => unknown) {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = () => onClick(b);
  return b;
}

// `rerender`: a page drawn before the wallet existed (#/mine, #/new) redraws with it.
async function connect(get: () => Wallet | Promise<Wallet>, rerender = true) {
  try {
    await get();
    renderWallet();
    if (rerender) dispatchEvent(new HashChangeEvent("hashchange"));
  } catch (e) {
    bar.append(errorLine(e));
  }
}

// The relay sponsors wallets below this (relay/sponsor.ts FUNDED).
const NEEDS_GLM = 10_000_000_000_000_000n; // 0.01 GLM

const KEY_NOTE = {
  browser:
    "This key exists only in this browser. Clearing site data deletes it; export it to keep it.",
  "telegram-secure":
    "This key is in Telegram's secure storage on this phone and never leaves it. Export it to keep a copy.",
  "telegram-device":
    "This key is in Telegram's storage on this device only. Export it to keep a copy.",
};

// Some webviews (Telegram's among them) block the clipboard: fall back to showing the key.
async function exportKey(b: HTMLButtonElement) {
  const key = (await storedKey())!;
  try {
    await navigator.clipboard.writeText(key);
    b.textContent = "Copied";
  } catch {
    prompt(
      "Your private key. Keep it secret: anyone with it controls this wallet.",
      key,
    );
  }
}

function renderWallet() {
  const w = wallet();
  if (!w) {
    // The Telegram webview has no MetaMask.
    bar.replaceChildren(
      ...(tg
        ? [button("Create my wallet", () => connect(useLocalKey))]
        : [
            button("Connect MetaMask", () => connect(connectMetaMask)),
            button("Make a key in this browser", () => connect(useLocalKey)),
          ]),
    );
    return;
  }
  const addr = document.createElement("code");
  addr.textContent = w.address;
  addr.title = w.kind === "local" ? "key on this device" : "MetaMask";
  const bal = document.createElement("span");
  bal.textContent = "… GLM";
  const sponsor = document.createElement("span");
  balance(w.address).then(
    (wei) => {
      bal.textContent = glm(wei);
      if (wei < NEEDS_GLM) sponsor.replaceChildren(...fundingHelp(w));
    },
    () => (bal.textContent = "balance unavailable"),
  );
  bar.replaceChildren(addr, " · ", bal, " ", sponsor);

  if (w.kind === "local") {
    const note = p(KEY_NOTE[w.storage ?? "browser"]);
    note.className = "note";
    bar.append(" ", button("Export key", exportKey), note);
  }
}

// An unfunded wallet can't sign anything: free GLM inside Telegram, the faucet everywhere else.
function fundingHelp(w: Wallet): (string | Node)[] {
  const faucet = link(FAUCET, "faucet");
  if (!canSponsor()) return ["Needs GLM: ", faucet];
  return [
    button("Get free GLM to start", async (b) => {
      b.disabled = true;
      b.textContent = "Sending…";
      try {
        await requestSponsor(w.address);
        renderWallet();
      } catch (e) {
        b.replaceWith(errorLine(e), p("Or use the ", faucet, "."));
      }
    }),
  ];
}

// A stored key comes back on reopen; MetaMask waits for a click (connecting is a prompt). The key is
// read before the first render (storage is async), so pages draw once, with the wallet.
boot();
const stored = await storedKey().catch(() => null);
if (stored) await connect(useLocalKey, false);
else renderWallet();

startRouter(app, [
  [
    /^\/$/,
    (el) => {
      el.innerHTML = `<p>Watch Arkiv entities: get told before one expires, when it changes,
        or keep it alive. Every action leaves a receipt on Arkiv that can't be rewritten; deletion
        is publicly logged.</p>
        <p><a href="#/new">Create a subscription</a> · <a href="#/mine">My subscriptions</a> · <a href="#/coverage">Coverage</a></p>`;
    },
  ],
  [/^\/new$/, newPage],
  [/^\/s\/(0x[0-9a-fA-F]{64})$/, statusPage],
  [/^\/coverage$/, coveragePage],
  [/^\/mine$/, minePage],
]);
