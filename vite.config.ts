// The static web app (LLD §7). Env comes from the repo-root .env files the workers use.
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // An explicit allow-list, not a prefix: ARKIV_ACCESS_KEY must never reach the bundle.
  // VITE_* (VITE_BOT_NAME) still arrives through import.meta.env as usual.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    root: "web",
    envDir: "..",
    define: {
      __ARKIV_HTTP__: JSON.stringify(
        env.ARKIV_HTTP || "https://rpc.tiramisu.db-chain.testnet.arkiv.network",
      ),
    },
  };
});
