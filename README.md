# Prometheus

Watch and keep alive entities on [Arkiv](https://arkiv.network): workers watch for expiry, changes and new matches, write public receipts on Arkiv, and a relay delivers them to Telegram.

Work in progress.

## Run

Requires Node 24+.

```bash
npm ci
cp .env.example .env   # fill in the values
npm run check && npm test
```

## Deploy

Worker A, the relay and HTTPS run on one Docker host with [`compose.yaml`](compose.yaml) (live: a DigitalOcean droplet). Worker B goes on a different host, so one outage can't stop both.

| Service    | Runs                        | Disk (`./state/…`)                     | Public    |
| ---------- | --------------------------- | -------------------------------------- | --------- |
| `worker-a` | `node worker/index.ts`      | checkpoint, unsent receipts, heartbeat | no        |
| `relay`    | `node relay/index.ts`       | follows (`relay.db`) + checkpoint      | via caddy |
| `caddy`    | HTTPS proxy to `relay:8080` | the certificate                        | 80, 443   |

The `state` folders must survive redeploys: losing the relay's means every Telegram follow is gone.

On the host, next to `compose.yaml`, create (`chmod 600`; never commit or bake them into the image):

- `.env.worker-a`: `ARKIV_HTTP`, `ARKIV_WS`, `TRUSTED_WORKERS`, `ARKIV_ACCESS_KEY`, `WORKER_PRIVATE_KEY`, `WORKER_DELAY_BLOCKS=0`
- `.env.relay`: `ARKIV_HTTP`, `ARKIV_WS`, `TRUSTED_WORKERS`, `ARKIV_ACCESS_KEY`, `SPONSOR_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`
- `.env`: `RELAY_HOST=<ip-with-dashes>.sslip.io` (or your own domain pointed at the host)

```bash
docker compose up -d --build        # first deploy and every update
curl https://$RELAY_HOST/health     # worker A listed in workersAlive
```

Firewall: inbound 22, 80 (certificate challenge), 443 only. Stop any local copy of worker A or the relay first: two worker A's race for nonces, and two relays make Telegram refuse the bot's polling.

### Worker B

Same image, its own droplet in another region (live: DigitalOcean `sfo2`; A is in `nyc1`), so a host or datacenter outage can't take both. It serves nothing, so its firewall allows inbound SSH (22) only. It needs no compose file:

- `.env.worker-b` (`chmod 600`): the same variables as `.env.worker-a`, with B's own `ARKIV_ACCESS_KEY` and `WORKER_PRIVATE_KEY`, and `WORKER_DELAY_BLOCKS=15`

```bash
docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t prometheus .
docker run -d --name worker-b --init --restart unless-stopped --stop-timeout 10 \
  --log-opt max-size=10m --log-opt max-file=3 \
  --env-file .env.worker-b -v "$PWD/state/worker-b:/app/state" \
  prometheus node worker/index.ts
```

`--init` and the log options match `compose.yaml`. To update: rebuild, then `docker rm -f worker-b` and run it again (the state folder keeps its place). Deploy the same commit to both workers. `/health` on the relay lists both once B is up.

## License

MIT
