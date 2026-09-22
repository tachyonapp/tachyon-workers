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
| `universe-refresh` | 1 (default — no explicit retry policy) | — | — |

`universe-refresh` deliberately has no BullMQ-level retry/backoff, unlike every other queue above. A per-bucket EODHD failure never throws out of the job — it's caught, logged, and recorded via the application-level circuit breaker (see [Universe Refresh](#universe-refresh-market-scanning) below) instead of failing the BullMQ job. Only a genuine infrastructure fault (e.g. Valkey unreachable) would fail the job itself, and since the next cron tick is ~5 minutes away regardless, a BullMQ retry policy would add little.

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
| `universe-refresh` | 1 | Cron + on-demand | `58,3,8,13,18,23,28,33,38,43,48,53 13-21 * * 1-5` | Fires 2 min ahead of every `scan-dispatch` tick. Also self-enqueues targeted, single-bucket out-of-band jobs (not cron-triggered) — see [Universe Refresh](#universe-refresh-market-scanning) |

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
| `EODHD_API_KEY` | Yes (for `universe-refresh`) | — | EODHD API key. Never logged unmasked — see `eodhd-client.ts`'s `maskApiKeyInUrl()` |
| `UNIVERSE_REFRESH_ENABLED` | No | `false` | Dark-launch gate for the `universe-refresh` worker. Must be explicitly `"true"` for it to make any EODHD call |
| `UNIVERSE_REFRESH_FAST_TIER_SECONDS` | No | `300` | Bucket cache TTL-equivalent (`expiresAt = asOf + this`) used for every bucket write today — see [Universe Refresh](#universe-refresh-market-scanning) for why only the FAST tier is currently used |
| `EODHD_BREAKER_FAILURE_THRESHOLD` | No | `3` | Consecutive fully-failed `universe-refresh` **ticks** (not buckets) before the circuit breaker opens |
| `EODHD_BREAKER_BACKOFF_SECONDS` | No | `300,900,1800` | Comma-separated capped exponential backoff schedule (seconds) applied once the breaker is open |
| `EARNINGS_REFRESH_LOOKAHEAD_HOURS` | No | `24` | Window before a symbol's `nextEarningsDate` within which an extra, immediate out-of-band bucket refresh is triggered |
| `UNIVERSE_FILTER_EARNINGS_STANDDOWN_WINDOW_DAYS` | No | `5` | Calendar days before `nextEarningsDate` within which `universe-filter-chain.ts` excludes a candidate for a `STAND_DOWN`-configured bot. **Distinct from** `EARNINGS_REFRESH_LOOKAHEAD_HOURS` above — that one triggers a data refresh (hours), this one is a trading-risk exclusion gate (days). See [Universe Filter Chain](#universe-filter-chain) |
| `UNIVERSE_FILTER_SHORT_INTEREST_HIGH_THRESHOLD_PCT` | No | `20` | `shortInterestPct` threshold (percentage points) used by both `AVOID_HIGH_SHORT_INTEREST` (excludes above it) and `TARGET_SHORT_SQUEEZE` (requires strictly above it) in `universe-filter-chain.ts` |

> `UNIVERSE_REFRESH_SLOW_TIER_SECONDS`, `SCAN_STALENESS_MAX_AGE_FAST_SECONDS`, `SCAN_STALENESS_MAX_AGE_SLOW_SECONDS`, `SLOW_TIER_DEGRADED_SERVE_SUSTAINED_THRESHOLD_SECONDS`, and `SLOW_TIER_DEGRADED_SERVE_OUTER_CAP_SECONDS` are already provisioned in `tachyon-infra`'s App Spec but are **not yet read by any code in this repo** — they're reserved for the staleness gate that wires into `scan-bot.worker.ts` (not yet built). Don't assume they do anything today.

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

## Universe Refresh (Market Scanning)

### What it is

`universe-refresh.worker.ts` populates a Valkey cache of tradeable symbols, bucketed by `<parentSector>:<marketCapTier>` (44 buckets = 11 `ALLOWED_SECTORS` parent sectors × 4 `MarketCapTier` values), so `scan-bot.worker.ts` can eventually read candidate symbols from cache instead of calling the market-data vendor (EODHD) directly. This worker is currently the **only** module in the codebase permitted to call EODHD (`eodhd-client.ts`).

It is **dark-launched**: `UNIVERSE_REFRESH_ENABLED` defaults to `false` in every environment, so it can be validated in staging with zero risk to `scan-bot.worker.ts`'s live guards before being turned on.

### Why it is needed

Calling EODHD's Screener/Fundamentals APIs directly from `scan-bot.worker.ts` on every bot's scan would mean one EODHD call per active bot per scan tick — cost and rate-limit exposure that scales with user count. Pre-fetching all 44 sector/cap-tier buckets on a fixed cron cadence decouples EODHD call volume from active-bot count entirely.

### How it works

On each tick, the worker:

1. Checks `UNIVERSE_REFRESH_ENABLED` — no-ops immediately if not `"true"`.
2. Reads the circuit breaker state (`universe-cache.ts`) — skips the entire tick with zero EODHD calls if the breaker is `OPEN` and its backoff window hasn't elapsed.
3. Iterates every `(parentSector, marketCapTier)` bucket (or just one, for a targeted out-of-band job — see below). For each bucket: acquires a short-TTL single-flight lock (skips the bucket this tick if already held), fetches the sector/cap-tier screener results + per-symbol fundamentals, translates each result's raw EODHD GICS sub-industry to a Tachyon label via `GICS_SUB_SECTOR_MAP` (empty array if unmapped — not an error), and writes the bucket to Valkey with no TTL (freshness is enforced by comparing `asOf`/`expiresAt` fields at read time, not by key expiry).
4. One bucket's EODHD failure is logged and does not abort the rest of the loop (same try/catch-per-item pattern as [Audit Log Partition Maintenance](#audit-log-partition-maintenance) above).

**MVP simplification:** the TDD describes independent FAST/SLOW refresh cadences per field (price vs. fundamentals). `UniverseBucketCacheEntry` only carries one `tier` per bucket, so every bucket write today is gated by the single `UNIVERSE_REFRESH_FAST_TIER_SECONDS` interval — fundamentals refresh exactly as often as price does, not on a separate slower cadence. `UNIVERSE_REFRESH_SLOW_TIER_SECONDS` is provisioned in the App Spec but unused until a future change reintroduces true per-field gating.

### Circuit breaker — per-tick, not per-bucket

The breaker (`universe-cache.ts`'s `recordRefreshSuccess`/`recordRefreshFailure`) is updated **once per tick**, based on the tick's aggregate outcome across all attempted buckets — not once per bucket:

- **All** attempted buckets failed → one `recordRefreshFailure` call.
- **Any** bucket succeeded → one `recordRefreshSuccess` call.

Calling `recordRefreshFailure`/`recordRefreshSuccess` per bucket would let a single lucky bucket reset the failure counter via `recordRefreshSuccess`'s unconditional `CLOSED` reset, even while most other buckets in the same tick are failing — masking a real partial outage. Aggregating per tick also changes what `EODHD_BREAKER_FAILURE_THRESHOLD` means in practice: **N consecutive fully-failed ticks (~5 min apart)**, not N bucket failures within one tick — which better matches "sustained outage" as the alerting is meant to detect. A Sentry event (`eodhd_outage_sustained` fingerprint) fires exactly once, on the `CLOSED`→`OPEN` transition, never on every failed tick while already open.

### Out-of-band refresh (imminent earnings)

Independent of the cron cadence: after a full sweep refreshes a bucket, if any symbol's `nextEarningsDate` falls within `EARNINGS_REFRESH_LOOKAHEAD_HOURS`, the worker enqueues **one** follow-up job targeting just that bucket (`UniverseRefreshJobPayload.targetBucketKey`, format `"<parentSector>:<marketCapTier>"` — not the Valkey key format, which only `universe-cache.ts` constructs). This exists because `earningsBehavior` settings for certain agent frames (e.g. `STAND_DOWN` near earnings) depend on fresh earnings-proximity data, and waiting for the next full cadence tick could mean acting on stale data right when it matters most.

**Important:** a targeted job never re-runs this check on itself. If it did, a still-imminent earnings date would cause the targeted job to immediately re-enqueue another targeted job, which would do the same — an unbounded, self-sustaining loop hammering EODHD for one bucket, fully decoupled from the cron schedule. Only a full sweep (`targetBucketKey` unset) ever evaluates this trigger; see the guard test in `universe-refresh.worker.test.ts` ("prevents an infinite self-triggering loop").

### halt heuristic

EODHD does offer real trading-status/halt data (a per-symbol WebSocket push stream), but it's a poor architectural fit for this worker's bulk, criteria-based, universe-wide screening design (the stream is capped at 50 symbol subscriptions by default). Full rationale is recorded in the Market Scanning & Universe Filtering TDD's Open Questions section, under "Halt heuristic's exact definition" — that document lives in the planning project, not in this repo. **Do not re-add a halt heuristic without reading that decision first.**

---

## Universe Filter Chain

### What it is

`universe-filter-chain.ts` (`runFilterChain()`) narrows the cached universe of candidate symbols down to what's actually eligible for one agents's configuration. It is **pure** — no network I/O, no Valkey/DB access. It takes an in-memory array of candidates (already read from the bucket cache by the caller) and a agents's settings/frame, and returns a filtered, reordered candidate list. `scan-bot.worker.ts` will be its only caller once wired up.

### Why it is needed

Universe Refresh populates the shared cache with every symbol matching a sector/market-cap bucket — hundreds of names per bucket. Each AI agent only wants the subset that matches its own configuration (sub-sectors, market-cap/liquidity tier, earnings posture, dividend preference, watchlist/exclusion lists, short-interest posture). This module is where that per-bot narrowing happens, entirely in-process against already-cached data — no per-agent EODHD or DB call.

### Fixed stage order

The 8 stages run in one fixed order, never reorderable by agent configuration, each its own separately named, separately testable function:

```
asset type → sector/sub-sector → market cap → liquidity →
earnings exclusion → dividend preference → watchlist/exclusion → short-interest
```

1. **Asset type** — a documented pass-through today. `UniverseBucketSymbolEntry` has no `assetType` field; the bucket-fetch pipeline's GICS-sector-based EODHD Screener query structurally only returns individual equities (ETFs have no GICS sector and are excluded upstream by construction, not here). Kept as its own stage so the order stays self-evident in review and a future `assetType` field has an obvious place to plug in.
2. **Sector/sub-sector** — a Tier A sub-sector selection matches candidates whose `resolvedSubSectors` contains the label. A **Tier B** selection (see `TIER_B_SUB_SECTORS`) matches by **parent sector only**, regardless of `resolvedSubSectors` — Tier B entries have an empty `resolvedSubSectors` by design (no `GICS_SUB_SECTOR_MAP` entry exists for them), so this stage never attempts a map lookup for a Tier B label. This is why `UniverseBucketSymbolEntry` carries a `parentSector` field (added alongside this task) — without it, there'd be no way to tell "correctly included from the right parent sector" apart from "wrongly included from an unrelated one."
3. **Market cap** — keeps candidates within one of the frame's configured `marketCapTiers` bands, **and** always enforces `PLATFORM_LIMITS.minMarketCapUsd` underneath every frame, including `SURGE`. Band numbers live in `MARKET_CAP_TIER_USD_BANDS` (`tachyon-queue-types`) — the same shared constant `eodhd-client.ts` uses to build its EODHD query, so the two can never silently drift apart.
4. **Liquidity** — same shape as market cap: frame's `LiquidityTier` minimum (`LIQUIDITY_TIER_MIN_ADV_USD`), floored by `PLATFORM_LIMITS.minAvgDollarVolumeUsd`.
5. **Earnings exclusion** — see [`UNIVERSE_FILTER_EARNINGS_STANDDOWN_WINDOW_DAYS`](#environment-variables) above. Only `STAND_DOWN` excludes; `NEUTRAL`/`MORE_AGGRESSIVE` are no-ops at this stage. A candidate with an unknown `nextEarningsDate` is never excluded on a data gap.
6. **Dividend preference** — `PREFER_DIVIDEND` requires a positive `dividendYield`; `EXCLUDE_DIVIDEND` requires none; `NO_PREFERENCE` is a no-op.
7. **Watchlist/exclusion** — `exclusionList` tickers are dropped first, then `customWatchlist` tickers are moved to the front of the surviving list (FR8: prioritized *ahead of*, not merely included in, the rest). A watchlisted ticker is **not** exempt from any earlier stage — it only skips ahead in ordering if it already survived sectors/cap/liquidity/earnings/dividend filtering.
8. **Short-interest** — see [`UNIVERSE_FILTER_SHORT_INTEREST_HIGH_THRESHOLD_PCT`](#environment-variables) above. `AVOID_HIGH_SHORT_INTEREST` excludes above the threshold (unknown data never excludes — can't penalize a vendor data gap); `TARGET_SHORT_SQUEEZE` requires *strictly above* the same threshold to be included at all (unknown data **does** exclude here — "can't confirm it meets the stated criteria," the opposite default from the avoid-gate, by design); `IGNORE` is a no-op. `shortInterestPct` is stored as a fraction (`0.05` = 5%, matching `dividendYield`'s convention) — the env var is expressed in percentage points and converted internally.

### Two numeric decisions

The earnings-exclusion window and the short-interest threshold both required a live product decision during implementation. Both decisions (and their full reasoning) are recorded in the Market Scanning & Universe Filtering TDD's Open Questions section — read that before changing either threshold.

### Determinism

Every function in this file must be a pure function of its inputs: no AI/ML calls, no adaptive/learned thresholds, no `brain-router.ts` calls. This is a hard constraint enforced by code review, not a style preference.

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
