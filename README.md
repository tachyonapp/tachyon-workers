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
2. Open Valkey connections for all worker processors (side effect of importing worker modules)
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
| `scan-dispatch` | 3 | exponential | 5,000 ms |
| `scan-bot` | 3 | exponential | 5,000 ms |
| `expiry` | 5 | exponential | 2,000 ms |
| `reconciliation` | 5 | exponential | 10,000 ms |
| `notification` | 4 | exponential | 5,000 ms |
| `summary` | 3 | exponential | 30,000 ms |
| `reset-ai-counters` | 3 | exponential | 5,000 ms |
| `trial-expiry-check` | 3 | exponential | 5,000 ms |
| `audit-log-partition` | 3 | exponential | 10,000 ms |

All queues use `removeOnComplete: { count: 100 }` and `removeOnFail: { count: 100 }`. These limits handle routine cleanup automatically — jobs are pruned on every add operation.

### Workers

| Worker | Concurrency | Trigger | Cron (UTC) | Notes |
|---|---|---|---|---|
| `scan-dispatch` | 1 | Cron | `*/5 14-21 * * 1-5` | Market-hours guard runs first; no-op outside 9:30 AM–4:00 PM ET. Fan-out: enqueues one `scan-bot` job per active bot via a single `addBulk()` call |
| `scan-bot` | `BULLMQ_CONCURRENCY` (default 5) | On-demand | — | Enqueued by `scan-dispatch`. Re-validates bot ownership and broker connection before proceeding |
| `expiry` | `BULLMQ_CONCURRENCY` (default 5) | Cron | `* * * * *` | 24/7 — proposals expire by wall-clock time, not market session |
| `reconciliation` | 1 | Cron | `*/5 * * * *` | 24/7 — kept at concurrency 1 to avoid redundant concurrent writes |
| `notification` | `BULLMQ_CONCURRENCY` (default 5) | On-demand | — | Event-driven; enqueued by the API or other workers on trade/funding events |
| `summary` | 1 | Cron | `5 21 * * 1-5` | 21:05 UTC = safely post-close in both EST and EDT. Generates EOD bot reports |
| `reset-ai-counters` | 1 | Cron | `0 5 * * 1-5` | 05:00 UTC ≈ midnight ET. Resets `ai_calls_today` to 0 for prior trading days |
| `trial-expiry-check` | 1 | Cron | `5 0 * * *` | 00:05 UTC daily. Transitions expired `FREE_TRIAL` subscriptions |
| `audit-log-partition` | 1 | Cron | `0 0 25 * *` | Midnight UTC on the 25th of every month. See [Audit Log Partition Maintenance](#audit-log-partition-maintenance) |

`scan-bot` and `notification` are not cron-scheduled — they are enqueued on demand only.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `POSTGRES_SSL` | No | `false` | Set to `true` to enable SSL (required for DigitalOcean managed PostgreSQL) |
| `VALKEY_HOST` | No | `localhost` | Valkey hostname |
| `VALKEY_PORT` | No | `6379` | Valkey port |
| `VALKEY_PASSWORD` | No | — | Valkey auth password (empty = no auth, typical for local dev) |
| `VALKEY_TLS` | No | `false` | Set to `true` to enable TLS (required for DigitalOcean managed Valkey) |
| `BULLMQ_CONCURRENCY` | No | `5` | Per-process job concurrency for `scan-bot`, `expiry`, and `notification` workers |
| `SENTRY_DSN` | No | — | Sentry DSN for error capture. Absent = Sentry disabled (local dev) |
| `NODE_ENV` | No | `development` | Passed to Sentry for environment tagging (`staging`, `production`) |

## Audit Log Partition Maintenance

### What it is

The `audit-log-partition` cron manages the monthly partitions of the `rule_audit_log` table. It runs at midnight UTC on the 25th of every month — six days before the next month begins — so the new partition is always in place before the first audit row of the month arrives.

### Why it is needed

`rule_audit_log` is a range-partitioned PostgreSQL table that records every Deterministic Rule Engine evaluation. It is an immutable compliance artifact: rows can never be deleted by the application, and gaps in the log are a regulatory defect.

Partition management is required for two reasons:

1. **Query performance.** Without pre-created partitions, new rows fall into the `rule_audit_log_default` partition, which is unoptimized for indexed queries. Monthly partitions allow PostgreSQL to prune irrelevant partitions during queries, keeping reads fast as the table grows.

2. **Regulatory retention lifecycle.** Financial compliance regulations (GDPR/CCPA, RIA audit obligations) require that records are queryable for a minimum window and permanently deleted after the maximum retention period expires. The cron enforces this automatically:
   - **0–24 months:** partition is attached and fully queryable
   - **24 months–5 years:** partition is detached (`DETACH PARTITION CONCURRENTLY`) — invisible to active queries but reattachable within 4 business hours for regulatory examination
   - **Beyond 5 years:** partition is dropped (`DROP TABLE`) — permanent deletion as required after the retention window closes

### How it works

On each run the worker:

1. **Creates the next month's partition** — `CREATE TABLE IF NOT EXISTS rule_audit_log_YYYY_MM PARTITION OF rule_audit_log FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01')`. Idempotent: if the partition already exists the step is skipped.
2. **Revokes DELETE on the new partition** — `REVOKE DELETE ON rule_audit_log_YYYY_MM FROM tachyon_app`. Enforces the append-only compliance requirement on every new partition. Idempotent: safe to re-run.
3. **Detaches old partitions** — for any partition whose month is ≥ 24 months in the past and is still attached, runs `ALTER TABLE rule_audit_log DETACH PARTITION ... CONCURRENTLY`. This must execute outside a transaction block; the worker does not wrap it in one.
4. **Drops expired partitions** — for any partition whose month is ≥ 60 months (5 years) in the past, runs `DROP TABLE IF EXISTS rule_audit_log_YYYY_MM`. This permanently removes the data in compliance with the post-retention-window deletion requirement.

Each DDL step is independently wrapped in try/catch. Detach and drop failures are non-fatal and are logged with Sentry capture — a transient failure on one step or one partition does not abort the rest of the run. BullMQ will retry the job up to 3 times with exponential backoff on a hard failure.

### Compliance note

The `REVOKE DELETE` step in item 2 above is a compliance control, not just a best-effort setting. Every new partition must have DELETE revoked before any rows are written to it. The worker applies this immediately after creating each partition. If the cron is delayed or skipped, rows for the new month route to `rule_audit_log_default` (no data loss), but the default partition may not have DELETE revoked — see the task notes for USER-02 in the Feature 9 dev tasks for context.

### Reattaching a detached partition

If a detached partition must be made queryable for a regulatory examination or audit, follow the runbook:

> [`tachyon-infra/runbooks/rule-audit-log-partition-reattachment.md`](../tachyon-infra/runbooks/rule-audit-log-partition-reattachment.md)

**SLA: 4 business hours** from request to partition reattached and queryable.

---

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
