// The only module that reads process.env (LLD §8). Node only.
// Checks every variable a role needs and throws once, listing every problem.

type Hex = `0x${string}`;

type Base = { http: string; ws: string; accessKey?: string };
export type WorkerConfig = Base & { privateKey: Hex; delayBlocks: number };
export type RelayConfig = Base & {
  trustedWorkers: Hex[];
  sponsorKey: Hex;
  telegramToken: string;
};
type Configs = { worker: WorkerConfig; relay: RelayConfig };
export type Role = keyof Configs;

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

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

  const base: Base = {
    http: read("ARKIV_HTTP", url("https:"), "an https:// URL")!,
    ws: read("ARKIV_WS", url("wss:"), "a wss:// URL")!,
    // Optional: without it, calls use the anonymous quota.
    accessKey: env.ARKIV_ACCESS_KEY?.trim() || undefined,
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
    };
  } else {
    const trusted = read(
      "TRUSTED_WORKERS",
      (v) => v.split(",").every((a) => ADDRESS.test(a.trim())),
      "comma-separated 0x addresses",
    );
    config = {
      ...base,
      trustedWorkers: (trusted?.split(",").map((a) => a.trim()) ?? []) as Hex[],
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
    };
  }

  if (problems.length)
    throw new Error(`Invalid config (${role}):\n- ${problems.join("\n- ")}`);
  return config as Configs[R];
}
