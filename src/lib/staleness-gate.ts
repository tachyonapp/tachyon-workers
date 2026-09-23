/**
 * Staleness Gate
 *
 * A hard, deterministic max-age gate on cached bucket data — the one
 * place scan-bot.worker.ts decides whether cached universe data is fresh
 * enough to build a candidate list from. Reuses bucket-fetch.ts (never
 * eodhd-client.ts directly) for the bounded synchronous refresh
 * It never calls EODHD directly, only through this module.
 *
 * Multi-bucket aggregation:
 *
 * an agent's relevant buckets can span more than
 * one (parentSector, marketCapTier) pair — a frame with several
 * marketCapTiers, sub_sectors spanning multiple parent sectors, or no
 * sub_sectors at all (full-universe eligible). This gate evaluates EVERY
 * relevant bucket and aggregates to exactly ONE outcome using the most
 * protective rule: if any bucket ends up SKIPPED, the whole evaluation is
 * SKIPPED — a candidate list partly built from fresh data and partly from
 * unrefreshable stale data is not something that
 * should be let through just because some other bucket happened to be fine.
 * Short of a full SKIP, the least-fresh outcome wins (SLOW_TIER_DEGRADED_SERVE
 * over BOUNDED_REFRESH_SUCCESS over PASS), so the one audit row this produces
 * reflects the worst case actually encountered, not an average.
 *
 * FAST vs SLOW tier: universe-refresh.worker.ts's current MVP simplification
 * writes every bucket with tier "FAST" — there is no live path that
 * produces a "SLOW" cached entry today. The SLOW-tier degraded-serve branch
 * below is still fully implemented and tested (constructing a "SLOW" fixture
 * directly), because it must be correct the moment we reintroduce true
 * per-field cadence gating — it just isn't reachable via the live system yet.
 */
import {
  MarketCapTier,
  type UniverseBucketCacheEntry,
  type UniverseBucketSymbolEntry,
} from "@tachyonapp/tachyon-queue-types";
import { fetchBucketSymbols } from "./bucket-fetch";
import {
  bucketCacheKey,
  readBucket,
  writeBucket,
  readBreakerState,
  acquireBucketLock,
  releaseBucketLock,
} from "./universe-cache";

function getFastThresholdSeconds(): number {
  return Number(process.env.SCAN_STALENESS_MAX_AGE_FAST_SECONDS ?? 240);
}

function getSlowThresholdSeconds(): number {
  return Number(process.env.SCAN_STALENESS_MAX_AGE_SLOW_SECONDS ?? 3000);
}

function getDegradedServeSustainedThresholdSeconds(): number {
  return Number(
    process.env.SLOW_TIER_DEGRADED_SERVE_SUSTAINED_THRESHOLD_SECONDS ?? 1800,
  );
}

function getDegradedServeOuterCapSeconds(): number {
  return Number(
    process.env.SLOW_TIER_DEGRADED_SERVE_OUTER_CAP_SECONDS ?? 86400,
  );
}

function getFastTierWriteSeconds(): number {
  return Number(process.env.UNIVERSE_REFRESH_FAST_TIER_SECONDS ?? 300);
}

// Own timeout, distinct from universe-refresh's cadence — this is a
// synchronous, in-request-path refresh attempt, not a scheduled sweep.
function getBoundedRefreshTimeoutMs(): number {
  return Number(process.env.SCAN_BOUNDED_REFRESH_TIMEOUT_MS ?? 5000);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Bounded refresh timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function performBoundedRefresh(
  parentSector: string,
  marketCapTier: MarketCapTier,
): Promise<UniverseBucketCacheEntry> {
  const bucketKey = bucketCacheKey(parentSector, marketCapTier);
  const symbols = await fetchBucketSymbols(parentSector, marketCapTier);
  const asOf = new Date();
  const expiresAt = new Date(asOf.getTime() + getFastTierWriteSeconds() * 1000);

  const entry: UniverseBucketCacheEntry = {
    bucketKey,
    asOf: asOf.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tier: "FAST",
    symbols,
  };

  await writeBucket(entry);
  return entry;
}

export type StalenessOutcome =
  | "PASS"
  | "BOUNDED_REFRESH_SUCCESS"
  | "SKIPPED"
  | "SLOW_TIER_DEGRADED_SERVE";

export interface StalenessGateBucketAudit {
  bucketKey: string;
  tier: "FAST" | "SLOW";
  asOf: string | null;
  ageSeconds: number | null;
  thresholdSeconds: number;
  breakerOpen: boolean;
}

interface PerBucketResult {
  outcome: StalenessOutcome;
  bucket: UniverseBucketCacheEntry | null; // null only for SKIPPED
  audit: StalenessGateBucketAudit;
}

const OUTCOME_SEVERITY: Record<StalenessOutcome, number> = {
  PASS: 0,
  BOUNDED_REFRESH_SUCCESS: 1,
  SLOW_TIER_DEGRADED_SERVE: 2,
  SKIPPED: 3,
};

// A few seconds beyond the bounded-refresh timeout — bounds how long a
// crashed/hung request can hold a bucket lock in this path.
function getBoundedRefreshLockTtlSeconds(): number {
  return Math.ceil(getBoundedRefreshTimeoutMs() / 1000) + 5;
}

async function evaluateSingleBucket(
  parentSector: string,
  marketCapTier: MarketCapTier,
): Promise<PerBucketResult> {
  const bucketKey = bucketCacheKey(parentSector, marketCapTier);
  const cached = await readBucket(parentSector, marketCapTier);

  // No cached entry at all (e.g. universe-refresh hasn't populated this
  // bucket yet) is treated the same as a breached bucket: attempt one
  // bounded refresh, else SKIPPED. Defaults to FAST-tier semantics (the
  // stricter threshold) since there's no prior tier to go on.
  const tier = cached?.tier ?? "FAST";
  const thresholdSeconds =
    tier === "FAST" ? getFastThresholdSeconds() : getSlowThresholdSeconds();
  const asOf = cached?.asOf ?? null;
  const ageSeconds = asOf
    ? Math.floor((Date.now() - new Date(asOf).getTime()) / 1000)
    : null;

  const isFresh = ageSeconds !== null && ageSeconds <= thresholdSeconds;

  if (isFresh && cached) {
    return {
      outcome: "PASS",
      bucket: cached,
      audit: {
        bucketKey,
        tier,
        asOf,
        ageSeconds,
        thresholdSeconds,
        breakerOpen: false,
      },
    };
  }

  // Breach — attempt exactly one bounded synchronous refresh. If the lock is
  // already held (e.g. a concurrent universe-refresh tick), treat that the
  // same as a failed attempt rather than waiting — NFR7 requires a
  // deterministic decision now, not an unbounded wait for someone else's refresh.
  const lockTtlSeconds = getBoundedRefreshLockTtlSeconds();
  const locked = await acquireBucketLock(bucketKey, lockTtlSeconds);
  let refreshedBucket: UniverseBucketCacheEntry | null = null;

  if (locked) {
    try {
      refreshedBucket = await withTimeout(
        performBoundedRefresh(parentSector, marketCapTier),
        getBoundedRefreshTimeoutMs(),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "staleness-gate.bounded-refresh-failed",
          bucketKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      refreshedBucket = null;
    } finally {
      await releaseBucketLock(bucketKey);
    }
  }

  if (refreshedBucket) {
    return {
      outcome: "BOUNDED_REFRESH_SUCCESS",
      bucket: refreshedBucket,
      audit: {
        bucketKey,
        tier,
        asOf: refreshedBucket.asOf,
        ageSeconds: 0,
        thresholdSeconds,
        breakerOpen: false,
      },
    };
  }

  if (tier === "FAST") {
    // Absolute gate — no exception under any condition, not even a breaker
    // check. FAST-tier data is never served past its threshold, period.
    return {
      outcome: "SKIPPED",
      bucket: null,
      audit: {
        bucketKey,
        tier,
        asOf,
        ageSeconds,
        thresholdSeconds,
        breakerOpen: false,
      },
    };
  }

  // SLOW tier only: the narrow, audited degraded-serve exception (NFR13).
  const breakerState = await readBreakerState();
  const breakerOpen = breakerState.state === "OPEN";
  const openedForSeconds =
    breakerOpen && breakerState.openedAt
      ? Math.floor(
          (Date.now() - new Date(breakerState.openedAt).getTime()) / 1000,
        )
      : 0;

  const sustainedOutage =
    breakerOpen &&
    openedForSeconds >= getDegradedServeSustainedThresholdSeconds();
  const withinOuterCap =
    ageSeconds !== null && ageSeconds <= getDegradedServeOuterCapSeconds();

  if (cached && sustainedOutage && withinOuterCap) {
    return {
      outcome: "SLOW_TIER_DEGRADED_SERVE",
      bucket: cached,
      audit: {
        bucketKey,
        tier,
        asOf,
        ageSeconds,
        thresholdSeconds,
        breakerOpen: true,
      },
    };
  }

  return {
    outcome: "SKIPPED",
    bucket: null,
    audit: { bucketKey, tier, asOf, ageSeconds, thresholdSeconds, breakerOpen },
  };
}

export interface StalenessGateResult {
  outcome: StalenessOutcome;
  // Union of every successfully-evaluated bucket's symbols — empty when the
  // aggregate outcome is SKIPPED (see file header: a partial candidate list
  // is not served just because some other relevant bucket happened to pass).
  candidateSymbols: UniverseBucketSymbolEntry[];
  // Describes the single worst-case bucket that drove the aggregate outcome —
  // this is what gets written to the one scan_audit_log row (Step 7).
  audit: StalenessGateBucketAudit;
}

export async function evaluateStalenessGate(
  buckets: Array<{ parentSector: string; marketCapTier: MarketCapTier }>,
): Promise<StalenessGateResult> {
  const results = await Promise.all(
    buckets.map(({ parentSector, marketCapTier }) =>
      evaluateSingleBucket(parentSector, marketCapTier),
    ),
  );

  const worst = results.reduce((acc, r) =>
    OUTCOME_SEVERITY[r.outcome] > OUTCOME_SEVERITY[acc.outcome] ? r : acc,
  );

  const candidateSymbols =
    worst.outcome === "SKIPPED"
      ? []
      : results.flatMap((r) => r.bucket?.symbols ?? []);

  return { outcome: worst.outcome, candidateSymbols, audit: worst.audit };
}
