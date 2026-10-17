// The only module that reads process.env (LLD §8). Node only.
// Checks every variable a role needs and throws once, listing every problem.

import { getAddress, isAddress } from "viem";

type Hex = `0x${string}`;

// trustedWorkers: both roles trust only receipts these wallets created, never a lookalike.
type Base = {
  http: string;
  ws: string;
  accessKey?: string;
  trustedWorkers: Hex[];
};
// version: the commit the image was built from (GIT_SHA), shown on the worker entity.
export type WorkerConfig = Base & {
  privateKey: Hex;
  delayBlocks: number;
  version: string;
};
export type RelayConfig = Base & {
  sponsorKey: Hex;
  telegramToken: string;
  dbPath: string;
  port: number;
  webUrl?: string; // the deployed web app, opened as the Telegram Mini App
  openrouterKey?: string; // unset = the docs assistant (POST /ask) is off
  askModels?: string[]; // OpenRouter model ids, first choice first; unset = ask.ts FREE_MODELS
  askDailyCap: number; // questions per UTC day, across everyone
};
type Configs = { worker: WorkerConfig; relay: RelayConfig };
export type Role = keyof Configs;

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export function loadConfig<R extends Role>(
  role: R,
  env: Record<string, string | undefined> = process.env,
): Configs[R] {
  const problems: string[] = [];

  // Reads one variable; records a problem and returns undefined if it is missing or fails `check`.
  // Messages never include the value, because some values are secrets.
  const read = (name: string, check: (v: string) => boolean, rule: string) => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is missing`);
    else if (!check(v)) problems.push(`${name} must be ${rule}`);
    else return v;
  };
  const url = (protocol: string) => (v: string) =>
    URL.canParse(v) && new URL(v).protocol === protocol;

  const trusted = read(
    "TRUSTED_WORKERS",
    // isAddress also checks the EIP-55 checksum of a mixed-case address, catching typos.
    (v) => v.split(",").every((a) => isAddress(a.trim())),
    "comma-separated 0x addresses (a mixed-case one must have a valid checksum)",
  );
  const base: Base = {
    http: read("ARKIV_HTTP", url("https:"), "an https:// URL")!,
    ws: read("ARKIV_WS", url("wss:"), "a wss:// URL")!,
    // Optional: without it, calls use the anonymous quota.
    accessKey: env.ARKIV_ACCESS_KEY?.trim() || undefined,
    // Checksummed, like rawGetEntity's creators, so equality checks need no lowercasing.
    trustedWorkers: (trusted?.split(",").map((a) => getAddress(a.trim())) ??
      []) as Hex[],
  };

  let config;
  if (role === "worker") {
    const delay = read(
      "WORKER_DELAY_BLOCKS",
      (v) => /^\d+$/.test(v),
      "a whole number of blocks",
    );
    config = {
      ...base,
      privateKey: read(
        "WORKER_PRIVATE_KEY",
        (v) => PRIVATE_KEY.test(v),
        "0x + 64 hex chars",
      ) as Hex,
      delayBlocks: Number(delay),
      // Optional: the Dockerfile sets it from --build-arg; a local run says "dev".
      version: env.GIT_SHA?.trim()
        ? read("GIT_SHA", (v) => /^[0-9a-f]{7,40}$/.test(v), "a git commit SHA")
        : "dev",
    };
  } else {
    // Optional: hosts like Railway set PORT; checked only when present.
    const port = env.PORT?.trim()
      ? read(
          "PORT",
          (v) => /^\d+$/.test(v) && Number(v) <= 65_535,
          "a port number (0–65535)",
        )
      : "8080";
    config = {
      ...base,
      sponsorKey: read(
        "SPONSOR_PRIVATE_KEY",
        (v) => PRIVATE_KEY.test(v),
        "0x + 64 hex chars",
      ) as Hex,
      telegramToken: read(
        "TELEGRAM_BOT_TOKEN",
        (v) => /^\d+:[\w-]+$/.test(v),
        "<bot id>:<secret>",
      )!,
      // Optional: on the host, point it at a mounted volume (Q-7) so follows survive a redeploy.
      dbPath: env.RELAY_DB_PATH?.trim() || "state/relay.db",
      port: Number(port),
      // Optional: Telegram opens Mini Apps over https only.
      webUrl: env.WEB_URL?.trim()
        ? read("WEB_URL", url("https:"), "an https:// URL")
        : undefined,
      // Optional: the docs assistant on OpenRouter. Its free models allow 50 requests a day on an
      // account that never bought credits, so the default cap stays just under that.
      openrouterKey: env.OPENROUTER_API_KEY?.trim() || undefined,
      askModels:
        env.ASK_MODELS?.split(",")
          .map((m) => m.trim())
          .filter(Boolean) || undefined,
      askDailyCap: Number(
        env.ASK_DAILY_CAP?.trim()
          ? read("ASK_DAILY_CAP", (v) => /^\d+$/.test(v), "a whole number")
          : "45",
      ),
    };
  }

  if (problems.length)
    throw new Error(`Invalid config (${role}):\n- ${problems.join("\n- ")}`);
  return config as Configs[R];
}
