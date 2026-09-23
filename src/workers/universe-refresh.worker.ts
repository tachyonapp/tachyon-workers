/**
 * Universe Refresh Worker (Market Scanning)
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
 * UniverseBucketCacheEntry only carries a single `tier` per bucket
 * (see tachyon-queue-types), so this worker gates the whole bucket
 * by the FAST tier interval rather than mixing field-level partial writes —
 * an explicitly permitted MVP simplification. Per symbol gating to be
 * considered post-MVP
 *
 * See README section Universe Refresh (Market Scanning) for more
 * detailed documentation on this worker.
 */
import { Worker, type Job } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  MarketCapTier,
  ALLOWED_SECTORS,
  type UniverseRefreshJobPayload,
  type UniverseBucketSymbolEntry,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { universeRefreshQueue } from "../queues/universe-refresh.queue";
import { fetchBucketSymbols } from "../lib/bucket-fetch";
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

function getEarningsLookaheadHours(): number {
  return Number(process.env.EARNINGS_REFRESH_LOOKAHEAD_HOURS ?? 24);
}

// Business-level bucket identifier used in job payloads — deliberately
// distinct from bucketCacheKey()'s Valkey-specific "universe:bucket:*" format
// (universe-cache.ts alone owns that). Matches UniverseBucketKey's documented
// shape: "<parentSector>:<marketCapTier>".
function toUniverseBucketKey(
  parentSector: string,
  marketCapTier: MarketCapTier,
): string {
  return `${parentSector}:${marketCapTier}`;
}

function parseUniverseBucketKey(key: string): {
  parentSector: string;
  marketCapTier: MarketCapTier;
} {
  const [parentSector, marketCapTier] = key.split(":");
  return { parentSector, marketCapTier: marketCapTier as MarketCapTier };
}

function isEarningsImminent(symbols: UniverseBucketSymbolEntry[]): boolean {
  const cutoffMs = Date.now() + getEarningsLookaheadHours() * 60 * 60 * 1000;
  return symbols.some((s) => {
    if (!s.nextEarningsDate) return false;
    const earningsMs = new Date(s.nextEarningsDate).getTime();
    return earningsMs >= Date.now() && earningsMs <= cutoffMs;
  });
}

async function enqueueOutOfBandRefresh(
  targetBucketKey: string,
  reason: "earnings_imminent",
): Promise<void> {
  await universeRefreshQueue.add(QUEUE_NAMES.UNIVERSE_REFRESH, {
    triggeredAt: new Date().toISOString(),
    targetBucketKey,
  } satisfies UniverseRefreshJobPayload);

  console.log(
    JSON.stringify({
      level: "info",
      event: "universe-refresh.out-of-band-enqueued",
      targetBucketKey,
      reason,
    }),
  );
}

async function refreshBucket(
  parentSector: string,
  marketCapTier: MarketCapTier,
  { checkOutOfBandTriggers }: { checkOutOfBandTriggers: boolean },
): Promise<void> {
  const bucketKey = bucketCacheKey(parentSector, marketCapTier);

  const symbols: UniverseBucketSymbolEntry[] = await fetchBucketSymbols(
    parentSector,
    marketCapTier,
  );

  const asOf = new Date();
  const expiresAt = new Date(asOf.getTime() + getFastTierSeconds() * 1000);

  await writeBucket({
    bucketKey,
    asOf: asOf.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tier: "FAST",
    symbols,
  });

  if (!checkOutOfBandTriggers) return;

  if (isEarningsImminent(symbols)) {
    const targetBucketKey = toUniverseBucketKey(parentSector, marketCapTier);
    await enqueueOutOfBandRefresh(targetBucketKey, "earnings_imminent");
  }
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

  const isTargetedRun = Boolean(job.data.targetBucketKey);
  const bucketsToProcess = isTargetedRun
    ? [parseUniverseBucketKey(job.data.targetBucketKey!)]
    : ALLOWED_SECTORS.flatMap(({ parentSector }) =>
        Object.values(MarketCapTier).map((marketCapTier) => ({
          parentSector,
          marketCapTier,
        })),
      );

  console.log(
    JSON.stringify({
      level: "info",
      event: "universe-refresh.started",
      triggeredAt: job.data.triggeredAt,
      targeted: isTargetedRun,
      bucketCount: bucketsToProcess.length,
    }),
  );

  let attemptedBuckets = 0;
  let succeededBuckets = 0;
  let skippedLockedBuckets = 0;

  for (const { parentSector, marketCapTier } of bucketsToProcess) {
    const bucketKey = bucketCacheKey(parentSector, marketCapTier);
    const locked = await acquireBucketLock(bucketKey, BUCKET_LOCK_TTL_SECONDS);
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
      // Out-of-band triggers only ever fire from a full sweep — see file
      // header for why a targeted run must not re-check/re-enqueue itself.
      await refreshBucket(parentSector, marketCapTier, {
        checkOutOfBandTriggers: !isTargetedRun,
      });
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
