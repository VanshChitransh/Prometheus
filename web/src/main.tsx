// Entry. The same bundle runs as the Telegram Mini App (telegram.ts). A stored key comes back on
// reopen; MetaMask waits for a click (connecting is a prompt). The key is read before the first
// render (storage is async), so pages draw once, with the wallet.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { boot } from "./telegram.ts";
import { disconnected, storedKey, useLocalKey } from "./wallet.ts";

boot();
if (!disconnected() && (await storedKey().catch(() => null)))
  await useLocalKey().catch(() => {});

createRoot(document.querySelector("#app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
