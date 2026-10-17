// Entry: the wallet bar in the header, and the page router below it.
import { coveragePage } from "./pages/coverage.ts";
import { minePage } from "./pages/mine.ts";
import { newPage } from "./pages/new.ts";
import { statusPage } from "./pages/status.ts";
import { errorLine, startRouter } from "./router.ts";
import {
  balance,
  connectMetaMask,
  hasLocalKey,
  localKey,
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

function renderWallet() {
  const w = wallet();
  if (!w) {
    bar.replaceChildren(
      button("Connect MetaMask", () => connect(connectMetaMask)),
      button("Make a key in this browser", () => connect(useLocalKey)),
    );
    return;
  }
  const addr = document.createElement("code");
  addr.textContent = w.address;
  addr.title = w.kind === "local" ? "key in this browser" : "MetaMask";
  const bal = document.createElement("span");
  bal.textContent = "… GLM";
  balance(w.address).then(
    (b) => (bal.textContent = `${b} GLM`),
    () => (bal.textContent = "balance unavailable"),
  );
  bar.replaceChildren(addr, " · ", bal);

  if (w.kind === "local") {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent =
      "This key exists only in this browser. Clearing site data deletes it; export it to keep it.";
    bar.append(
      " ",
      button("Export key", async (b) => {
        await navigator.clipboard.writeText(localKey()!);
        b.textContent = "Copied";
      }),
      note,
    );
  }
}

// A generated key comes back on reload; MetaMask waits for a click (connecting is a prompt).
if (hasLocalKey())
  connect(useLocalKey, false); // before the first render
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
