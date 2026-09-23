jest.mock("../bucket-fetch", () => ({
  fetchBucketSymbols: jest.fn(),
}));

jest.mock("../universe-cache", () => ({
  bucketCacheKey: jest.fn(
    (parentSector: string, marketCapTier: string) =>
      `universe:bucket:${parentSector}:${marketCapTier}`,
  ),
  readBucket: jest.fn(),
  writeBucket: jest.fn(),
  readBreakerState: jest.fn(),
  acquireBucketLock: jest.fn(),
  releaseBucketLock: jest.fn(),
}));

import { MarketCapTier } from "@tachyonapp/tachyon-queue-types";
import type { UniverseBucketCacheEntry } from "@tachyonapp/tachyon-queue-types";
import { evaluateStalenessGate } from "../staleness-gate";
import * as bucketFetch from "../bucket-fetch";
import * as universeCache from "../universe-cache";

const mockedFetchBucketSymbols = bucketFetch.fetchBucketSymbols as jest.Mock;
const mockedReadBucket = universeCache.readBucket as jest.Mock;
const mockedWriteBucket = universeCache.writeBucket as jest.Mock;
const mockedReadBreakerState = universeCache.readBreakerState as jest.Mock;
const mockedAcquireBucketLock = universeCache.acquireBucketLock as jest.Mock;
const mockedReleaseBucketLock = universeCache.releaseBucketLock as jest.Mock;

const CLOSED_BREAKER = {
  state: "CLOSED" as const,
  consecutiveFailures: 0,
  openedAt: null,
  nextRetryAt: null,
  lastSuccessAt: null,
};

function freshBucket(overrides: Partial<UniverseBucketCacheEntry> = {}): UniverseBucketCacheEntry {
  return {
    bucketKey: "universe:bucket:Technology:MEGA_CAP",
    asOf: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    tier: "FAST",
    symbols: [
      {
        symbol: "AAPL",
        parentSector: "Technology",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        resolvedSubSectors: ["Consumer Electronics"],
        dividendYield: null,
        shortInterestPct: null,
        nextEarningsDate: null,
        price: 190,
      },
    ],
    ...overrides,
  };
}

function staleBucket(
  ageSeconds: number,
  overrides: Partial<UniverseBucketCacheEntry> = {},
): UniverseBucketCacheEntry {
  return freshBucket({
    asOf: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    ...overrides,
  });
}

const ONE_BUCKET = [{ parentSector: "Technology", marketCapTier: MarketCapTier.MEGA_CAP }];

describe("evaluateStalenessGate", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockedReadBreakerState.mockResolvedValue(CLOSED_BREAKER);
    mockedAcquireBucketLock.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("PASS: a fresh cached bucket needs no refresh", async () => {
    mockedReadBucket.mockResolvedValue(freshBucket());

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("PASS");
    expect(result.candidateSymbols).toHaveLength(1);
    expect(mockedFetchBucketSymbols).not.toHaveBeenCalled();
    expect(result.audit.breakerOpen).toBe(false);
  });

  it("BOUNDED_REFRESH_SUCCESS: a stale FAST bucket refreshes successfully within the timeout", async () => {
    mockedReadBucket.mockResolvedValue(staleBucket(9999)); // way past the FAST threshold
    mockedFetchBucketSymbols.mockResolvedValue([
      {
        symbol: "MSFT",
        parentSector: "Technology",
        marketCapUsd: 2_500_000_000_000,
        avgDollarVolume: 8_000_000_000,
        resolvedSubSectors: ["Software & SaaS"],
        dividendYield: null,
        shortInterestPct: null,
        nextEarningsDate: null,
        price: 400,
      },
    ]);

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("BOUNDED_REFRESH_SUCCESS");
    expect(result.candidateSymbols.map((s) => s.symbol)).toEqual(["MSFT"]);
    expect(mockedWriteBucket).toHaveBeenCalledTimes(1);
    expect(mockedReleaseBucketLock).toHaveBeenCalledTimes(1);
  });

  it("SKIPPED: a stale FAST bucket whose bounded refresh fails is always SKIPPED, regardless of breaker state", async () => {
    mockedReadBucket.mockResolvedValue(staleBucket(9999));
    mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));
    // Even with the breaker OPEN and well past the sustained/outer-cap
    // thresholds, FAST tier must still SKIP — the exception never applies to it.
    mockedReadBreakerState.mockResolvedValue({
      state: "OPEN",
      consecutiveFailures: 5,
      openedAt: new Date(Date.now() - 999_999_000).toISOString(),
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      lastSuccessAt: null,
    });

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("SKIPPED");
    expect(result.candidateSymbols).toEqual([]);
  });

  it("SKIPPED: a bounded refresh timeout is treated as a failed attempt", async () => {
    process.env.SCAN_BOUNDED_REFRESH_TIMEOUT_MS = "10";
    mockedReadBucket.mockResolvedValue(staleBucket(9999));
    mockedFetchBucketSymbols.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 1000)),
    );

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("SKIPPED");
  });

  it("SKIPPED: an already-held bucket lock is treated as a failed refresh attempt, never waited on", async () => {
    mockedReadBucket.mockResolvedValue(staleBucket(9999));
    mockedAcquireBucketLock.mockResolvedValue(false);

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("SKIPPED");
    expect(mockedFetchBucketSymbols).not.toHaveBeenCalled();
  });

  it("no cached entry at all is treated as a FAST-tier breach", async () => {
    mockedReadBucket.mockResolvedValue(null);
    mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("SKIPPED");
  });

  it("SLOW_TIER_DEGRADED_SERVE: a stale SLOW bucket whose refresh fails is served when the breaker has been open past the sustained threshold and within the outer cap", async () => {
    process.env.SLOW_TIER_DEGRADED_SERVE_SUSTAINED_THRESHOLD_SECONDS = "1800";
    process.env.SLOW_TIER_DEGRADED_SERVE_OUTER_CAP_SECONDS = "86400";
    mockedReadBucket.mockResolvedValue(
      staleBucket(50_000, { tier: "SLOW" }), // stale, but within the 24h outer cap
    );
    mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));
    mockedReadBreakerState.mockResolvedValue({
      state: "OPEN",
      consecutiveFailures: 5,
      openedAt: new Date(Date.now() - 3600_000).toISOString(), // open for 1h > 30min sustained threshold
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      lastSuccessAt: null,
    });

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("SLOW_TIER_DEGRADED_SERVE");
    expect(result.candidateSymbols).toHaveLength(1);
    expect(result.audit.breakerOpen).toBe(true);
  });

  it("SKIPPED: a stale SLOW bucket is not degraded-served when the breaker hasn't been open long enough", async () => {
    mockedReadBucket.mockResolvedValue(staleBucket(50_000, { tier: "SLOW" }));
    mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));
    mockedReadBreakerState.mockResolvedValue({
      state: "OPEN",
      consecutiveFailures: 5,
      openedAt: new Date(Date.now() - 60_000).toISOString(), // open only 1 min — below 30min sustained threshold
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      lastSuccessAt: null,
    });

    const result = await evaluateStalenessGate(ONE_BUCKET);

    expect(result.outcome).toBe("SKIPPED");
  });

  it("SKIPPED: a stale SLOW bucket beyond the outer cap is never degraded-served even with a long-open breaker", async () => {
    mockedReadBucket.mockResolvedValue(
      staleBucket(90_000, { tier: "SLOW" }), // older than the 86400s outer cap... wait needs > 86400
    );
    mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));
    mockedReadBreakerState.mockResolvedValue({
      state: "OPEN",
      consecutiveFailures: 5,
      openedAt: new Date(Date.now() - 999_999_000).toISOString(),
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      lastSuccessAt: null,
    });

    const result = await evaluateStalenessGate(ONE_BUCKET);

    // 90,000s < 86,400s outer cap is false — 90000 > 86400, so this IS beyond the cap.
    expect(result.outcome).toBe("SKIPPED");
  });

  describe("multi-bucket aggregation", () => {
    const TWO_BUCKETS = [
      { parentSector: "Technology", marketCapTier: MarketCapTier.MEGA_CAP },
      { parentSector: "Energy", marketCapTier: MarketCapTier.MEGA_CAP },
    ];

    it("aggregates to PASS with the union of symbols when every bucket passes", async () => {
      mockedReadBucket
        .mockResolvedValueOnce(freshBucket({ bucketKey: "universe:bucket:Technology:MEGA_CAP" }))
        .mockResolvedValueOnce(
          freshBucket({
            bucketKey: "universe:bucket:Energy:MEGA_CAP",
            symbols: [
              {
                symbol: "XOM",
                parentSector: "Energy",
                marketCapUsd: 400_000_000_000,
                avgDollarVolume: 1_000_000_000,
                resolvedSubSectors: ["Oil & Gas"],
                dividendYield: 0.03,
                shortInterestPct: null,
                nextEarningsDate: null,
                price: 110,
              },
            ],
          }),
        );

      const result = await evaluateStalenessGate(TWO_BUCKETS);

      expect(result.outcome).toBe("PASS");
      expect(result.candidateSymbols.map((s) => s.symbol).sort()).toEqual(["AAPL", "XOM"]);
    });

    it("aggregates to SKIPPED (discarding all candidates) when only one of several buckets is skipped", async () => {
      mockedReadBucket
        .mockResolvedValueOnce(freshBucket()) // Technology: fine
        .mockResolvedValueOnce(staleBucket(9999)); // Energy: stale, refresh will fail
      mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));

      const result = await evaluateStalenessGate(TWO_BUCKETS);

      expect(result.outcome).toBe("SKIPPED");
      expect(result.candidateSymbols).toEqual([]);
    });

    it("aggregates to the worst non-SKIPPED outcome (SLOW_TIER_DEGRADED_SERVE over PASS)", async () => {
      mockedReadBucket
        .mockResolvedValueOnce(freshBucket()) // Technology: PASS
        .mockResolvedValueOnce(staleBucket(50_000, { tier: "SLOW" })); // Energy: degraded-serve eligible
      mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));
      mockedReadBreakerState.mockResolvedValue({
        state: "OPEN",
        consecutiveFailures: 5,
        openedAt: new Date(Date.now() - 3600_000).toISOString(),
        nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
        lastSuccessAt: null,
      });

      const result = await evaluateStalenessGate(TWO_BUCKETS);

      expect(result.outcome).toBe("SLOW_TIER_DEGRADED_SERVE");
      // Both buckets' symbols still included — only a SKIPPED aggregate discards everything.
      expect(result.candidateSymbols).toHaveLength(2);
    });
  });
});
