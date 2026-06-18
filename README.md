# DM Capital — Backend

Express gateway between Deribit's public API and the React frontend. Maintains a
live WebSocket to Deribit, computes positioning / volatility metrics, and persists
history to SQLite via Prisma.

> Repo: `dm-capital-backend` · pairs with [`dm-capital-frontend`](https://github.com/AntonyChinVal/dm-capital-frontend)

## Local dev

```bash
pnpm install
pnpm prisma migrate dev      # first time — creates SQLite + schema
pnpm dev                     # → http://localhost:4000
```

Smoke test:

```bash
curl http://localhost:4000/api/health
```

## Deploy → Fly.io

One-time setup:

```bash
brew install flyctl
flyctl auth login

# Create app (edit `app` in fly.toml if you pick a different slug)
flyctl apps create dm-capital --org personal

# Persistent volume for SQLite (1 GB is plenty)
flyctl volumes create dm_capital_data --region gru --size 1 --app dm-capital

# First deploy
flyctl deploy --app dm-capital
```

Subsequent deploys: push to `master` (GitHub Actions runs `flyctl deploy`) or
run `flyctl deploy` locally.

### GitHub Actions secret

```bash
flyctl tokens create deploy -a dm-capital
# → GitHub repo → Settings → Secrets → Actions → FLY_API_TOKEN
```

### Environment (set in `fly.toml` or `flyctl secrets set`)

| Var | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Required for Fly health checks |
| `PORT` | `4000` | |
| `DATABASE_URL` | `file:/data/dm-capital.db` | Mounted volume at `/data` |
| `HISTORY_RETENTION_DAYS` | `90` | Optional |
| `FLOW_STREAM_MIN_BTC` | `1` | Visual feed threshold |
| `FLOW_AGG_MIN_BTC` | `0.1` | Net-flow aggregator threshold |

After deploy, note the public URL (e.g. `https://dm-capital.fly.dev`) — the
frontend needs it as `VITE_API_BASE_URL`.

## Key endpoints

| Path | Purpose |
|---|---|
| `GET /api/health` | Liveness + WS status |
| `GET /api/metrics?expiration=…` | OI, GEX, walls, flip |
| `GET /api/surface` | IV term structure + 3D data |
| `GET /api/synthesis` | Panorama tiles + bridge text |
| `GET /api/flow/net?window=1h\|4h\|24h` | Windowed net flow |
| `GET /api/history/metrics` | Mini-chart history |
| `SSE /api/flow/stream` | Live trade flow |
| `SSE /api/status/stream` | WS reconnect state |

Full plan and decisions: see `docs/ROADMAP.md` in the parent workspace.
