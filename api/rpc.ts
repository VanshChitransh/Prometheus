// The web app's JSON-RPC, forwarded to Arkiv with the access key (a Vercel function). Without a key
// every visitor gets ~100 reads an hour; with it they share the key's quota. web/src/wallet.ts falls
// back to the public RPC whenever this answers an error.
// ponytail: an open proxy, so anyone can spend the key's quota; add a method allow-list or a per-IP
// limit if that happens.
const RPC =
  process.env.ARKIV_HTTP ||
  "https://rpc.tiramisu.db-chain.testnet.arkiv.network";
const MAX_BODY = 65_536; // bytes; a query is well under 1 KB

export async function POST(req: Request): Promise<Response> {
  const key = process.env.ARKIV_ACCESS_KEY?.trim();
  // Keyless, every visitor would share the anonymous quota of Vercel's one IP: worse than their own.
  if (!key) return Response.json({ error: "No access key." }, { status: 503 });
  const body = await req.text();
  if (body.length > MAX_BODY)
    return Response.json({ error: "Request too large." }, { status: 413 });
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": key },
    body,
  });
  // Retry-After passes through: kit.tsx's errorText turns it into "try again in N min".
  const headers = new Headers({ "content-type": "application/json" });
  const wait = r.headers.get("retry-after");
  if (wait) headers.set("retry-after", wait);
  return new Response(r.body, { status: r.status, headers });
}
