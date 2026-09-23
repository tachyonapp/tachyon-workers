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

The `audit-log-partition` cron manages the monthly partitions of **two** range-partitioned tables — `rule_audit_log` (Deterministic Rule Engine evaluations) and `scan_audit_log` (market-scanning staleness-gate outcomes). It runs at midnight UTC on the 25th of every month — six days before the next month begins — so both tables' new partitions are always in place before the first row of the month arrives. One cron, one `Worker`, one job execution manages both tables sequentially; there is deliberately no second queue or cron registration for `scan_audit_log`.

### Why it is needed

`rule_audit_log` is an immutable compliance artifact: rows can never be deleted by the application, and gaps in the log are a regulatory defect. `scan_audit_log` is operational telemetry (staleness-gate/degraded-serve decisions from `scan-bot.worker.ts`) with no legal retention mandate — different compliance domain, different volume profile, different schema, tracked in its own table from day one (migration `016_market_scanning_universe_filtering.sql`) rather than folded into `rule_audit_log`.

Partition management is required for both tables for two reasons:

1. **Query performance.** Without pre-created partitions, new rows fall into the table's `_default` partition, which is unoptimized for indexed queries. Monthly partitions allow PostgreSQL to prune irrelevant partitions during queries, keeping reads fast as each table grows.

2. **Retention lifecycle**, enforced automatically by the cron — but on **different schedules per table**:

   | | `rule_audit_log` | `scan_audit_log` |
   |---|---|---|
   | Attached / fully queryable | 0–24 months | 0–6 months |
   | Detached (`DETACH PARTITION CONCURRENTLY`) | 24 months–5 years | 6–12 months |
   | Dropped (`DROP TABLE`) | beyond 5 years | beyond 12 months |
   | `REVOKE DELETE` on new partitions | Yes — GDPR/CCPA/RIA-mandated immutability | **No** — operational telemetry, no retention mandate |

   `rule_audit_log`'s 24-month/5-year cutoffs are the original, unchanged compliance-driven numbers. `scan_audit_log`'s 6-month/12-month cutoffs are **placeholders pending final confirmation** (TDD Open Questions) — trivially adjustable via the `SCAN_AUDIT_DETACH_MONTHS`/`SCAN_AUDIT_DROP_MONTHS` constants in `audit-log-partition.worker.ts`, not hardcoded magic numbers scattered through the file.

### How it works

The worker is generalized around a small `AuditPartitionTableConfig` (table name, partition prefix/regex, detach/drop month cutoffs, and a `revokeDelete` flag) so the same create/detach/drop logic runs once per table rather than being duplicated. Each run processes `rule_audit_log` first, then `scan_audit_log`, each producing its own `audit-log-partition.started`/`.completed` log pair tagged with a `table` field:

1. **Creates the next month's partition** — `CREATE TABLE IF NOT EXISTS <table>_YYYY_MM PARTITION OF <table> FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01')`. Idempotent: if the partition already exists the step is skipped.
2. **Revokes DELETE on the new partition — `rule_audit_log` only.** `REVOKE DELETE ON rule_audit_log_YYYY_MM FROM tachyon_app`, gated behind the config's `revokeDelete` flag. `scan_audit_log` partitions deliberately skip this step entirely — the flag exists specifically so this can't be accidentally copy-pasted back in when the two tables' logic was merged into one file.
3. **Detaches old partitions** — for any partition of that table whose month is past its own `detachMonths` cutoff and is still attached, runs `ALTER TABLE <table> DETACH PARTITION ... CONCURRENTLY`. This must execute outside a transaction block; the worker does not wrap it in one.
4. **Drops expired partitions** — for any partition of that table whose month is past its own `dropMonths` cutoff, runs `DROP TABLE IF EXISTS <table>_YYYY_MM`. This permanently removes the data.

Each DDL step is independently wrapped in try/catch. Detach and drop failures are non-fatal and are logged with Sentry capture — a transient failure on one step or one partition does not abort the rest of the run (for either table). BullMQ will retry the job up to 3 times with exponential backoff on a hard failure. A failure processing `rule_audit_log`'s create/revoke step aborts before `scan_audit_log` is attempted, since both currently run in the same job invocation.

### Compliance note

The `REVOKE DELETE` step applies **only to `rule_audit_log`**. Every new `rule_audit_log` partition must have DELETE revoked before any rows are written to it; the worker applies this immediately after creating each partition. If the cron is delayed or skipped, rows for the new month route to `rule_audit_log_default` (no data loss), but the default partition may not have DELETE revoked — see the task notes for USER-02 in the Feature 9 dev tasks for context. `scan_audit_log` has no equivalent control by design — `tachyon_app` retains DELETE on it in every partition, including the default.

### Reattaching a detached partition

If a detached `rule_audit_log` partition must be made queryable for a regulatory examination or audit, follow the runbook:

> [`tachyon-infra/runbooks/rule-audit-log-partition-reattachment.md`](../tachyon-infra/runbooks/rule-audit-log-partition-reattachment.md)

**SLA: 4 business hours** from request to partition reattached and queryable.

There is no equivalent SLA or runbook for `scan_audit_log` — it is operational telemetry, not a compliance record, so a detached partition can be reattached ad hoc (`ALTER TABLE scan_audit_log ATTACH PARTITION scan_audit_log_YYYY_MM FOR VALUES FROM (...) TO (...)`) without a formal process.

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

## Scan Bot Pipeline (Staleness Gate)

### What it is

`scan-bot.worker.ts` processes one agent per job (enqueued by `scan-dispatch`). After its three guard checks pass (agent ownership/ACTIVE check, broker connection, subscription-tier cap — all unchanged), it resolves the agents's relevant universe bucket(s), applies session/day narrowing, runs the staleness gate against the bucket cache, and on anything but a skip, runs it through [Universe Filter Chain](#universe-filter-chain) and logs the resulting candidate list at the point Feature 11 (scoring/proposal construction, not yet built) will eventually consume it.

### Session/day narrowing — no audit row

Before the staleness gate runs at all, `session_preference`/`day_avoidance` are checked against the current time (`session-preference.ts`). If the agent's preference excludes right now, the job returns immediately — **no `scan_audit_log` row is written**. This is deliberately separate from the staleness path below: it's an agent-preference narrowing, not a data-quality event, so it must stay invisible to the audit trail.

### The staleness gate — four outcomes, always exactly one audit row

`staleness-gate.ts`'s `evaluateStalenessGate()` is the one place an agent's scan decides whether cached data is fresh enough to trade on. Every evaluation writes exactly one `scan_audit_log` row, in every branch:

| Outcome | Meaning |
|---|---|
| `PASS` | Cached data is within its staleness threshold. No network call. |
| `BOUNDED_REFRESH_SUCCESS` | Cache was stale; one bounded synchronous refresh succeeded within its own timeout (`SCAN_BOUNDED_REFRESH_TIMEOUT_MS`). |
| `SKIPPED` | Stale and unrefreshable. For FAST-tier data this is absolute — no breaker state or condition ever produces an exception. |
| `SLOW_TIER_DEGRADED_SERVE` | SLOW-tier only: the circuit breaker has been open past `SLOW_TIER_DEGRADED_SERVE_SUSTAINED_THRESHOLD_SECONDS` and the cached data is still within `SLOW_TIER_DEGRADED_SERVE_OUTER_CAP_SECONDS` — last-known-good data is served as a narrow, audited exception. |

An agent's relevant buckets can span more than one `(parentSector, marketCapTier)` pair (a frame with several market-cap tiers, sub-sectors spanning multiple parent sectors, or no sub-sector restriction at all). The gate evaluates every relevant bucket and aggregates to one outcome via the most protective rule: if **any** bucket ends up `SKIPPED`, the whole evaluation is `SKIPPED` and every candidate is discarded — a list built from a mix of fresh and unrefreshably-stale data isn't served just because some other bucket happened to be fine. Short of a full skip, the least-fresh outcome wins, so the single audit row reflects the worst case actually encountered.

FAST-tier vs. SLOW-tier: `universe-refresh.worker.ts`'s current MVP simplification (see [Universe Refresh](#universe-refresh-market-scanning)) writes every bucket as `"FAST"` — there is no live path producing a `"SLOW"` cached entry today. The degraded-serve branch is fully implemented and tested against a constructed `"SLOW"` fixture, so it's correct the moment per-field cadence gating is reintroduced; it just isn't reachable via the live system yet.

### Why scan-bot.worker.ts never imports eodhd-client.ts — and why that's not defeated by the bounded refresh

`eodhd-client.ts` has exactly one importer in this codebase: `bucket-fetch.ts`. `scan-bot.worker.ts` reaches it only indirectly, through `staleness-gate.ts`'s bounded-refresh path. It's worth being precise about what this rule actually protects, because a literal reading ("scan-bot's call graph must never reach EODHD, even transitively") doesn't survive contact with the rest of the design — NFR7 itself *requires* a bounded synchronous refresh as part of the staleness gate, so "zero EODHD calls under any circumstance" was never the real constraint.

What the rule actually guards against is the anti-pattern Feature 10 exists to eliminate: EODHD call volume scaling with active-bot count instead of staying bounded to ~44 buckets per cadence tick (NFR2). If `scan-bot.worker.ts` could freely, independently call EODHD per bot with no coordination, that scaling problem comes right back — just moved one layer down. The import-boundary rule ("never import `eodhd-client.ts` directly") is a cheap, `grep`-able proxy for catching that failure mode in review, not the goal itself.

What actually matters is preserved because the bounded refresh goes through the *same shared discipline* `universe-refresh.worker.ts` uses, not an ad hoc one:

1. **Bucket-scoped, not bot-scoped** — keyed by `(parentSector, marketCapTier)`, the same key the full sweep uses. Bots with overlapping frame/sector selections share buckets.
2. **Single-flight locking still applies** — `acquireBucketLock()` is the identical lock. Two bots hitting the same stale bucket at once do not produce two concurrent EODHD calls; only one acquires the lock, the other is treated as a failed attempt.
3. **Writes back to the shared cache** — `writeBucket()` runs on a successful bounded refresh, so the bot that triggered it benefits every other bot sharing that bucket for the rest of its freshness window, not just itself.
4. **One bounded attempt, then a hard stop** — the same "try once, give up" discipline NFR7 mandates everywhere else, capped by its own timeout distinct from the full sweep's cadence.

If the bounded refresh instead bypassed the lock, called EODHD per-bot, or didn't write back to the shared cache, *that* would be the anti-pattern in a thin disguise. None of that is the case — which is why the rule's real intent (bounded, coordinated, shared EODHD access) holds, even though its literal wording is satisfied by "one hop removed" rather than by `scan-bot.worker.ts`'s call graph never reaching `eodhd-client.ts` at all.

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
