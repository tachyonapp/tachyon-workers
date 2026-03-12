# tachyon-workers

Background job processing service for the Tachyon platform (BullMQ + Valkey).

## Local Development

### Option A — Infrastructure only (recommended)

Start PostgreSQL and Valkey via Docker, then run workers directly:

```bash
# From tachyon-infra
docker compose up postgres valkey

# From this repo
cp ../tachyon-infra/env/.env.local.example .env.local
export NODE_AUTH_TOKEN=<your-github-pat>  # GitHub PAT with read:packages scope
npm install
npm run dev
```

### Option B — Full stack via Docker Compose

```bash
# From tachyon-infra — NODE_AUTH_TOKEN is required for the Docker build
# to pull @tachyonapp/tachyon-db from GitHub Packages
export NODE_AUTH_TOKEN=<your-github-pat>
docker compose up
```

### Option C — Build Docker image locally

```bash
export NODE_AUTH_TOKEN=<your-github-pat>
docker build --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
```

> `NODE_AUTH_TOKEN` is passed as a BuildKit secret and is never written to any
> image layer. It cannot be extracted via `docker history`.

## Scripts

```bash
npm run dev         # Start with hot reload (tsx watch)
npm run build       # Compile TypeScript
npm test            # Run Jest tests
npm run lint        # Run ESLint
npm run queue:clean # Flush completed/failed job history from all queues (see Queue Maintenance)
```

## Architecture

### Startup sequence

On process start, `src/index.ts` runs the following in order:

1. Initialize Sentry (gated on `SENTRY_DSN` — no-op in local dev)
2. Open Valkey connections for all 6 worker processors (side effect of importing worker modules)
3. Start the heartbeat — writes a TTL'd key to Valkey every 30 s so the infrastructure layer can detect live instances
4. Register cron job schedulers via `upsertJobScheduler` (idempotent — safe on every restart)

### Shutdown sequence

On `SIGTERM` or `SIGINT`:

1. Remove the heartbeat key from Valkey (instance is no longer visible)
2. Close all worker processors concurrently (drains in-flight jobs)
3. Exit 0

A 30-second hard timeout is enforced on step 2. DigitalOcean App Platform sends `SIGTERM` and expects the process to exit within 30 seconds before issuing `SIGKILL`.

## BullMQ

### Queues

| Queue | Attempts | Backoff type | Base delay |
|---|---|---|---|
| `scan:dispatch` | 3 | exponential | 5,000 ms |
| `scan:bot` | 3 | exponential | 5,000 ms |
| `expiry` | 5 | exponential | 2,000 ms |
| `reconciliation` | 5 | exponential | 10,000 ms |
| `notification` | 4 | exponential | 5,000 ms |
| `summary` | 3 | exponential | 30,000 ms |

All queues use `removeOnComplete: { count: 1000 }` and `removeOnFail: { count: 500 }`. These limits handle routine cleanup automatically — jobs are pruned on every add operation.

### Workers

| Worker | Concurrency | Trigger | Cron (UTC) | Notes |
|---|---|---|---|---|
| `scan:dispatch` | 1 | Cron | `*/15 14-21 * * 1-5` | Market-hours guard runs first; no-op outside 9:30 AM–4:00 PM ET. Fan-out: enqueues one `scan:bot` job per active bot via a single `addBulk()` call |
| `scan:bot` | `BULLMQ_CONCURRENCY` (default 5) | On-demand | — | Enqueued by `scan:dispatch`. Re-validates bot ownership and broker connection before proceeding |
| `expiry` | `BULLMQ_CONCURRENCY` (default 5) | Cron | `* * * * *` | 24/7 — proposals expire by wall-clock time, not market session |
| `reconciliation` | 1 | Cron | `*/5 * * * *` | 24/7 — kept at concurrency 1 to avoid redundant concurrent writes |
| `notification` | `BULLMQ_CONCURRENCY` (default 5) | On-demand | — | Event-driven; enqueued by the API or other workers on trade/funding events |
| `summary` | 1 | Cron | `5 21 * * 1-5` | 21:05 UTC = safely post-close in both EST and EDT. Generates EOD bot reports |

`scan:bot` and `notification` are not cron-scheduled — they are enqueued on demand only.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `POSTGRES_SSL` | No | `false` | Set to `true` to enable SSL (required for DigitalOcean managed PostgreSQL) |
| `VALKEY_HOST` | No | `localhost` | Valkey hostname |
| `VALKEY_PORT` | No | `6379` | Valkey port |
| `VALKEY_PASSWORD` | No | — | Valkey auth password (empty = no auth, typical for local dev) |
| `VALKEY_TLS` | No | `false` | Set to `true` to enable TLS (required for DigitalOcean managed Valkey) |
| `BULLMQ_CONCURRENCY` | No | `5` | Per-process job concurrency for `scan:bot`, `expiry`, and `notification` workers |
| `SENTRY_DSN` | No | — | Sentry DSN for error capture. Absent = Sentry disabled (local dev) |
| `NODE_ENV` | No | `development` | Passed to Sentry for environment tagging (`staging`, `production`) |

## Queue Maintenance

`queue:clean` is a **break-glass utility** — not a routine scheduled task. The per-queue `removeOnComplete`/`removeOnFail` retention limits handle day-to-day cleanup automatically.

Reach for it when:
- A bug caused a large volume of failed jobs to accumulate and you need a clean slate
- Storage pressure is observed on the Valkey instance and automatic pruning hasn't kept up
- Bull Board is unavailable and you need to flush job history from production manually
- Before a major queue rename or schema change

```bash
npm run queue:clean
```

Optional flags:

| Flag | Default | Description |
|---|---|---|
| `--grace <ms>` | `0` | Only remove jobs older than this many milliseconds |
| `--limit <n>` | `1000` | Maximum jobs to remove per queue per status |

Safe to run against production Valkey — only removes completed and failed job history, never active or waiting jobs. For staging, prefer the Bull Board dashboard at `http://localhost:4000/internal/bull-board` in local dev.
