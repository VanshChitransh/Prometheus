// The static web app (LLD §7). Env comes from the repo-root .env files the workers use.
import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { DOCS_NAV, splitFront } from "./web/src/docsMeta.ts";

// Files for agents, written from web/docs: /llms.txt (the index, llmstxt.org format),
// /llms-full.txt (every docs page in one file), and each page's raw Markdown at /docs/<slug>.md.
// Served from memory in dev, emitted as assets at build.
function agentFiles(site: string): Plugin {
  const read = (dir: string) => {
    const full = path.resolve("web", dir);
    if (!fs.existsSync(full)) return [];
    return fs
      .readdirSync(full)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const raw = fs
          .readFileSync(path.join(full, f), "utf8")
          .replaceAll("<site>", site || "<site>");
        return { slug: f.slice(0, -3), raw, ...splitFront(raw) };
      });
  };
  const files = () => {
    const docs = read("docs");
    const out = new Map<string, string>();
    for (const d of docs) out.set(`docs/${d.slug}.md`, d.raw);
    const bySlug = new Map(docs.map((d) => [d.slug, d]));
    const index = [
      "# Prometheus",
      "",
      "> Prometheus watches entities on Arkiv. It warns before an entity expires, tells you when it has expired, changed or a new matching entity appears, can keep an entity alive, and writes a public receipt on Arkiv for every action.",
      "",
      "Rules for agents: use the prometheus-arkiv SDK (npm i prometheus-arkiv @arkiv-network/sdk viem); it checks every subscription against the workers' rules before signing. Sign with the user's own wallet, never a hard-coded key. Never create a keep subscription for a canary or heartbeat (workers refuse them).",
      "",
      ...DOCS_NAV.flatMap((s) => {
        const pages = s.pages
          .map((p) => bySlug.get(p))
          .filter((d) => d !== undefined);
        return pages.length
          ? [
              `## ${s.title}`,
              "",
              ...pages.map(
                (d) =>
                  `- [${d.front.title}](${site}/docs/${d.slug}.md): ${d.front.description}`,
              ),
              "",
            ]
          : [];
      }),
    ].join("\n");
    out.set("llms.txt", index);
    const ordered = DOCS_NAV.flatMap((s) => s.pages)
      .map((p) => bySlug.get(p))
      .filter((d) => d !== undefined);
    out.set(
      "llms-full.txt",
      ordered
        .map(
          (d) =>
            `# ${d.front.title}\n\n${d.front.description}\n\n${d.body.trim()}\n`,
        )
        .join("\n---\n\n"),
    );
    return out;
  };
  return {
    name: "prometheus-agent-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // A query (?raw, ?import) is Vite loading the file as a module for the app: not ours.
        if (!req.url || req.url.includes("?")) return next();
        const name = decodeURIComponent(req.url).replace(/^\//, "");
        const body = files().get(name);
        if (body === undefined) return next();
        res.setHeader(
          "content-type",
          `${name.endsWith(".md") ? "text/markdown" : "text/plain"}; charset=utf-8`,
        );
        res.end(body);
      });
    },
    generateBundle() {
      for (const [fileName, source] of files())
        this.emitFile({ type: "asset", fileName, source });
    },
  };
}

export default defineConfig(({ mode }) => {
  // An explicit allow-list, not a prefix: ARKIV_ACCESS_KEY must never reach the bundle.
  const env = loadEnv(mode, process.cwd(), "");
  const rpc =
    env.ARKIV_HTTP || "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
  return {
    // `vite dev` doesn't run api/rpc.ts (a Vercel function), so this stands in for it: same keyed
    // forward, the key added here in Node. Without a key, /api/rpc 404s and reads go keyless.
    server: env.ARKIV_ACCESS_KEY
      ? {
          proxy: {
            "/api/rpc": {
              target: rpc,
              changeOrigin: true,
              rewrite: () => new URL(rpc).pathname,
              headers: { "X-API-KEY": env.ARKIV_ACCESS_KEY },
            },
          },
        }
      : undefined,
    root: "web",
    plugins: [
      react(),
      tailwindcss(),
      agentFiles((env.WEB_URL ?? "").replace(/\/$/, "")),
    ],
    envDir: "..",
    define: {
      __ARKIV_HTTP__: JSON.stringify(rpc),
      __TRUSTED_WORKERS__: JSON.stringify(env.TRUSTED_WORKERS ?? ""),
      // The relay's public https URL, for free GLM in the Mini App; empty = the faucet link instead.
      __RELAY_URL__: JSON.stringify(env.RELAY_PUBLIC_URL ?? ""),
      __BOT_NAME__: JSON.stringify(env.VITE_BOT_NAME ?? ""),
    },
  };
});
