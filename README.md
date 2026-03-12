# tachyon-workers

Background job processing service for the Tachyon platform (BullMQ + ValKey).

## Local Development

### Option A — Infrastructure only (recommended)

Start PostgreSQL and ValKey via Docker, then run workers directly:

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
npm run dev       # Start with hot reload (tsx watch)
npm run build     # Compile TypeScript
npm test          # Run Jest tests
npm run lint      # Run ESLint
```


## BullMQ

**Queue configuration reference:**

| Queue | Attempts | Backoff type | Base delay |
|---|---|---|---|
| `scan:dispatch` | 3 | exponential | 5,000 ms |
| `scan:bot` | 3 | exponential | 5,000 ms |
| `expiry` | 5 | exponential | 2,000 ms |
| `reconciliation` | 5 | exponential | 10,000 ms |
| `notification` | 4 | exponential | 5,000 ms |
| `summary` | 3 | exponential | 30,000 ms |

**Workers configuration reference:**

| Worker | Concurrency | Cron schedule (UTC) | Notes |
|---|---|---|---|
| `scan:dispatch` | 1 | `*/15 14-21 * * 1-5` | Market-hours guard fires first; no-op outside 9:30 AM–4:00 PM ET |
| `scan:bot` | `BULLMQ_CONCURRENCY` (default 5) | On-demand only | Enqueued in bulk by `scan:dispatch`; re-validates bot + broker before proceeding |
| `expiry` | `BULLMQ_CONCURRENCY` (default 5) | `* * * * *` | 24/7 — proposals expire by wall-clock time, not market session |
| `reconciliation` | 1 | `*/5 * * * *` | 24/7 — broad table reads; kept at 1 to avoid redundant concurrent writes |
| `notification` | `BULLMQ_CONCURRENCY` (default 5) | On-demand only | Event-driven; enqueued by API or other workers |
| `summary` | 1 | `5 21 * * 1-5` | 21:05 UTC = safely post-close in both EST and EDT |

All queues use `removeOnComplete: { count: 1000 }` and `removeOnFail: { count: 500 }`.

**Cron schedule reference:**

| Queue | Cron (UTC) | Notes |
|---|---|---|
| `scan:dispatch` | `*/15 14-21 * * 1-5` | Mon–Fri; job-level market hours guard handles 9:30 boundary |
| `expiry` | `* * * * *` | Every minute, 24/7 |
| `reconciliation` | `*/5 * * * *` | Every 5 min, 24/7 |
| `summary` | `5 21 * * 1-5` | Mon–Fri; 21:05 UTC = post-close in both EST and EDT |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `POSTGRES_SSL` | No | `false` | Set to `true` to enable SSL (required for DigitalOcean managed PG) |
| `VALKEY_HOST` | No | `localhost` | Valkey (Redis-compatible) hostname |
| `VALKEY_PORT` | No | `6379` | Valkey port |
| `VALKEY_PASSWORD` | No | — | Valkey password (empty = no auth, typical for local dev) |
| `VALKEY_TLS` | No | `false` | Set to `true` to enable TLS for Valkey (required for DigitalOcean managed Valkey) |
| `BULLMQ_CONCURRENCY` | No | `5` | Per-process concurrency for `scan:bot`, `expiry`, and `notification` workers |
| `SENTRY_DSN` | No | — | Sentry DSN for error capture. Absent = Sentry disabled (local dev) |
| `NODE_ENV` | No | `development` | Passed to Sentry for environment tagging |

## Queue Maintenance

To manually flush completed and failed jobs from all queues:

```bash
npm run queue:clean
```

Optional flags:

| Flag | Default | Description |
|---|---|---|
| `--grace <ms>` | `0` | Only remove jobs older than this many milliseconds |
| `--limit <n>` | `1000` | Maximum jobs to remove per queue per status |

Safe to run against production Valkey — only removes job history (completed/failed), not active or waiting jobs. For staging, prefer using the Bull Board dashboard (`http://localhost:4000/internal/bull-board` in local dev).
