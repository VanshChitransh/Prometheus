// The static web app (LLD §7). Env comes from the repo-root .env files the workers use.
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // An explicit allow-list, not a prefix: ARKIV_ACCESS_KEY must never reach the bundle.
  const env = loadEnv(mode, process.cwd(), "");
  return {
    root: "web",
    envDir: "..",
    define: {
      __ARKIV_HTTP__: JSON.stringify(
        env.ARKIV_HTTP || "https://rpc.tiramisu.db-chain.testnet.arkiv.network",
      ),
      __TRUSTED_WORKERS__: JSON.stringify(env.TRUSTED_WORKERS ?? ""),
      // The relay's public https URL, for free GLM in the Mini App; empty = the faucet link instead.
      __RELAY_URL__: JSON.stringify(env.RELAY_PUBLIC_URL ?? ""),
      __BOT_NAME__: JSON.stringify(env.VITE_BOT_NAME ?? ""),
    },
  };
});
