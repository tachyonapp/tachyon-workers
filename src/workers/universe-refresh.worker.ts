/**
 * Universe Refresh Worker
 *
 * Role: cron-triggered, universe-wide bucket refresh — NOT bot-specific. Populates
 * the `universe:bucket:<parentSector>:<marketCapTier>` Valkey cache (universe-cache.ts)
 * that scan-bot.worker.ts will read from once wired up. This worker is the
 * only caller of eodhd-client.ts.
 *
 * Dark launch: gated on UNIVERSE_REFRESH_ENABLED. Ships disabled in every
 * environment so it can be validated in staging
 * with zero risk to the live scan-bot guards before being flipped on.
 *
 * Circuit breaker granularity: the breaker is updated ONCE per tick, based on the
 * tick's AGGREGATE outcome across all ~44 buckets (all attempted buckets failed =
 * tick failure; at least one succeeded = tick success) — NOT once per bucket.
 * Calling recordRefreshFailure/recordRefreshSuccess per bucket would let a single lucky bucket mid-loop reset
 * the breaker via recordRefreshSuccess's unconditional CLOSED reset, even while
 * most other buckets in the same tick are failing — masking a real partial
 * outage. Aggregating per tick also makes failureThreshold mean "N consecutive
 * fully-failed ticks" rather than "N bucket failures within a single tick".
 *
 * Bucket write simplification (MVP): the TDD describes per-field FAST/SLOW tier
 * cadence gating within a bucket. UniverseBucketCacheEntry only carries a single
 * `tier` per bucket (see tachyon-queue-types), so this worker gates the whole
 * bucket by the FAST tier interval rather than mixing field-level partial writes —
 * an explicitly permitted MVP simplification.
 *
 * asOf simplification: EODHD's bulk Screener response has no single per-row
 * "source data timestamp" to use for `asOf` (unlike a per-symbol fundamentals
 * call). This worker uses the fetch completion time as a practical proxy.
 */
import { Worker, type Job } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  MarketCapTier,
  ALLOWED_SECTORS,
  GICS_SUB_SECTOR_MAP,
  type UniverseRefreshJobPayload,
  type UniverseBucketSymbolEntry,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { fetchScreenerBucket, fetchFundamentals } from "../lib/eodhd-client";
import {
  bucketCacheKey,
  writeBucket,
  readBreakerState,
  recordRefreshSuccess,
  recordRefreshFailure,
  acquireBucketLock,
  releaseBucketLock,
} from "../lib/universe-cache";

// A few seconds beyond the expected EODHD round-trip (screener + per-symbol
// fundamentals fan-out) — bounds how long a crashed worker can hold a bucket lock.
const BUCKET_LOCK_TTL_SECONDS = 30;

function getFailureThreshold(): number {
  return Number(process.env.EODHD_BREAKER_FAILURE_THRESHOLD ?? 3);
}

function getBackoffScheduleSeconds(): number[] {
  return (process.env.EODHD_BREAKER_BACKOFF_SECONDS ?? "300,900,1800")
    .split(",")
    .map(Number);
}

function getFastTierSeconds(): number {
  return Number(process.env.UNIVERSE_REFRESH_FAST_TIER_SECONDS ?? 300);
}

async function refreshBucket(
  parentSector: string,
  marketCapTier: MarketCapTier,
): Promise<void> {
  const bucketKey = bucketCacheKey(parentSector, marketCapTier);

  const screenerResults = await fetchScreenerBucket({
    parentSector,
    marketCapTier,
  });
  const fundamentals = await fetchFundamentals(
    screenerResults.map((r) => r.symbol),
  );
  const fundamentalsBySymbol = new Map(fundamentals.map((f) => [f.symbol, f]));

  const symbols: UniverseBucketSymbolEntry[] = screenerResults.map((r) => {
    const fund = fundamentalsBySymbol.get(r.symbol);
    // No map entry (Tier B / unclassified) resolves to an empty array, not an error.
    const resolvedLabel = GICS_SUB_SECTOR_MAP[r.gicsSubIndustry];
    return {
      symbol: r.symbol,
      marketCapUsd: r.marketCapUsd,
      avgDollarVolume: r.avgDollarVolume,
      resolvedSubSectors: resolvedLabel ? [resolvedLabel] : [],
      dividendYield: fund?.dividendYield ?? null,
      shortInterestPct: fund?.shortInterestPct ?? null,
      nextEarningsDate: fund?.nextEarningsDate ?? null,
      price: r.price,
    };
  });

  const asOf = new Date();
  const expiresAt = new Date(asOf.getTime() + getFastTierSeconds() * 1000);

  await writeBucket({
    bucketKey,
    asOf: asOf.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tier: "FAST",
    symbols,
  });
}

export async function processUniverseRefresh(
  job: Job<UniverseRefreshJobPayload>,
): Promise<void> {
  if (process.env.UNIVERSE_REFRESH_ENABLED !== "true") {
    console.log(
      JSON.stringify({
        level: "info",
        event: "universe-refresh.disabled",
        triggeredAt: job.data.triggeredAt,
      }),
    );
    return;
  }

  const breakerState = await readBreakerState();
  if (
    breakerState.state === "OPEN" &&
    breakerState.nextRetryAt &&
    new Date() < new Date(breakerState.nextRetryAt)
  ) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "universe-refresh.breaker-open-skip",
        nextRetryAt: breakerState.nextRetryAt,
      }),
    );
    return;
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "universe-refresh.started",
      triggeredAt: job.data.triggeredAt,
    }),
  );

  let attemptedBuckets = 0;
  let succeededBuckets = 0;
  let skippedLockedBuckets = 0;

  for (const { parentSector } of ALLOWED_SECTORS) {
    for (const marketCapTier of Object.values(MarketCapTier)) {
      const bucketKey = bucketCacheKey(parentSector, marketCapTier);
      const locked = await acquireBucketLock(
        bucketKey,
        BUCKET_LOCK_TTL_SECONDS,
      );
      if (!locked) {
        skippedLockedBuckets++;
        console.log(
          JSON.stringify({
            level: "info",
            event: "universe-refresh.bucket-locked-skip",
            bucketKey,
          }),
        );
        continue;
      }

      attemptedBuckets++;
      try {
        await refreshBucket(parentSector, marketCapTier);
        succeededBuckets++;
        console.log(
          JSON.stringify({
            level: "info",
            event: "universe-refresh.bucket-refreshed",
            bucketKey,
          }),
        );
      } catch (err) {
        // Per-item try/catch — one bucket's EODHD failure must not abort the
        // rest of the loop (mirrors audit-log-partition.worker.ts's pattern).
        console.error(
          JSON.stringify({
            level: "error",
            event: "universe-refresh.bucket-failed",
            bucketKey,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        await releaseBucketLock(bucketKey);
      }
    }
  }

  // Aggregate breaker update — see file header for why this is per-tick, not per-bucket.
  const allAttemptedBucketsFailed =
    attemptedBuckets > 0 && succeededBuckets === 0;

  if (allAttemptedBucketsFailed) {
    const { justOpened } = await recordRefreshFailure(
      getFailureThreshold(),
      getBackoffScheduleSeconds(),
    );

    if (justOpened) {
      Sentry.captureMessage("EODHD sustained outage — circuit breaker opened", {
        level: "error",
        fingerprint: ["eodhd_outage_sustained"],
        extra: {
          consecutiveFailures: (await readBreakerState()).consecutiveFailures,
          threshold: getFailureThreshold(),
        },
      });
    }
  } else if (attemptedBuckets > 0) {
    await recordRefreshSuccess();
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "universe-refresh.completed",
      attemptedBuckets,
      succeededBuckets,
      skippedLockedBuckets,
    }),
  );
}

export const universeRefreshWorker = new Worker<UniverseRefreshJobPayload>(
  QUEUE_NAMES.UNIVERSE_REFRESH,
  processUniverseRefresh,
  {
    connection: getBullMQConnectionOptions(),
    concurrency: 1,
  },
);

// Structured error logging + Sentry capture on every failed job.
// job may be undefined if BullMQ fails before the job object is hydrated.
universeRefreshWorker.on("failed", (job, error) => {
  const context = {
    jobId: job?.id,
    queue: job?.queueName,
    attemptsMade: job?.attemptsMade,
    payload: job?.data,
  };
  console.error(
    JSON.stringify({
      level: "error",
      event: "job_failed",
      ...context,
      error: error.message,
      stack: error.stack,
    }),
  );
  Sentry.captureException(error, { extra: context });
});
