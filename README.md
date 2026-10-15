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

## License

MIT
