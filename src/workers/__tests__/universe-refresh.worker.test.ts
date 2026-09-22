// Prevent BullMQ Worker from opening Redis connections during unit tests
jest.mock("bullmq", () => ({
  Worker: jest
    .fn()
    .mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
  Queue: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@sentry/node", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("../../lib/eodhd-client", () => ({
  fetchScreenerBucket: jest.fn(),
  fetchFundamentals: jest.fn(),
}));

jest.mock("../../lib/universe-cache", () => ({
  bucketCacheKey: jest.fn(
    (parentSector: string, marketCapTier: string) =>
      `universe:bucket:${parentSector}:${marketCapTier}`,
  ),
  writeBucket: jest.fn(),
  readBreakerState: jest.fn(),
  recordRefreshSuccess: jest.fn(),
  recordRefreshFailure: jest.fn(),
  acquireBucketLock: jest.fn(),
  releaseBucketLock: jest.fn(),
}));

import * as Sentry from "@sentry/node";
import type { Job } from "bullmq";
import {
  ALLOWED_SECTORS,
  MarketCapTier,
} from "@tachyonapp/tachyon-queue-types";
import type { UniverseRefreshJobPayload } from "@tachyonapp/tachyon-queue-types";
import { processUniverseRefresh } from "../universe-refresh.worker";
import * as eodhdClient from "../../lib/eodhd-client";
import * as universeCache from "../../lib/universe-cache";

const TOTAL_BUCKETS =
  ALLOWED_SECTORS.length * Object.values(MarketCapTier).length;

function makeJob(): Job<UniverseRefreshJobPayload> {
  return {
    data: { triggeredAt: new Date().toISOString() },
  } as Job<UniverseRefreshJobPayload>;
}

const mockedFetchScreenerBucket = eodhdClient.fetchScreenerBucket as jest.Mock;
const mockedFetchFundamentals = eodhdClient.fetchFundamentals as jest.Mock;
const mockedReadBreakerState = universeCache.readBreakerState as jest.Mock;
const mockedRecordRefreshSuccess =
  universeCache.recordRefreshSuccess as jest.Mock;
const mockedRecordRefreshFailure =
  universeCache.recordRefreshFailure as jest.Mock;
const mockedAcquireBucketLock = universeCache.acquireBucketLock as jest.Mock;
const mockedWriteBucket = universeCache.writeBucket as jest.Mock;

const CLOSED_BREAKER = {
  state: "CLOSED" as const,
  consecutiveFailures: 0,
  openedAt: null,
  nextRetryAt: null,
  lastSuccessAt: null,
};

describe("processUniverseRefresh", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, UNIVERSE_REFRESH_ENABLED: "true" };
    mockedAcquireBucketLock.mockResolvedValue(true);
    mockedReadBreakerState.mockResolvedValue(CLOSED_BREAKER);
    mockedFetchScreenerBucket.mockResolvedValue([
      {
        symbol: "AAPL",
        gicsSubIndustry: "Consumer Electronics",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        price: 190,
      },
    ]);
    mockedFetchFundamentals.mockResolvedValue([
      {
        symbol: "AAPL",
        dividendYield: 0.005,
        shortInterestPct: 0.01,
        nextEarningsDate: "2026-10-30",
      },
    ]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("no-ops with zero EODHD calls when UNIVERSE_REFRESH_ENABLED is not 'true'", async () => {
    process.env.UNIVERSE_REFRESH_ENABLED = "false";

    await processUniverseRefresh(makeJob());

    expect(mockedReadBreakerState).not.toHaveBeenCalled();
    expect(mockedFetchScreenerBucket).not.toHaveBeenCalled();
  });

  it("skips the entire tick with zero EODHD calls when the breaker is OPEN and backoff hasn't elapsed", async () => {
    mockedReadBreakerState.mockResolvedValue({
      state: "OPEN",
      consecutiveFailures: 3,
      openedAt: new Date().toISOString(),
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      lastSuccessAt: null,
    });

    await processUniverseRefresh(makeJob());

    expect(mockedFetchScreenerBucket).not.toHaveBeenCalled();
    expect(mockedAcquireBucketLock).not.toHaveBeenCalled();
  });

  it("attempts every bucket, writes each one, and records a single aggregate success when all succeed", async () => {
    await processUniverseRefresh(makeJob());

    expect(mockedFetchScreenerBucket).toHaveBeenCalledTimes(TOTAL_BUCKETS);
    expect(mockedWriteBucket).toHaveBeenCalledTimes(TOTAL_BUCKETS);
    expect(mockedRecordRefreshSuccess).toHaveBeenCalledTimes(1);
    expect(mockedRecordRefreshFailure).not.toHaveBeenCalled();
  });

  it("resolves the raw GICS sub-industry to a Tachyon label via GICS_SUB_SECTOR_MAP", async () => {
    await processUniverseRefresh(makeJob());

    const firstWriteArg = mockedWriteBucket.mock.calls[0][0];
    expect(firstWriteArg.symbols[0].resolvedSubSectors).toEqual([
      "Consumer Electronics",
    ]);
  });

  it("resolves to an empty array when the raw GICS sub-industry has no map entry", async () => {
    mockedFetchScreenerBucket.mockResolvedValue([
      {
        symbol: "UNKNOWNCO",
        gicsSubIndustry: "Some Unmapped GICS Sub-Industry",
        marketCapUsd: 5_000_000_000,
        avgDollarVolume: 100_000_000,
        price: 50,
      },
    ]);
    mockedFetchFundamentals.mockResolvedValue([]);

    await processUniverseRefresh(makeJob());

    const firstWriteArg = mockedWriteBucket.mock.calls[0][0];
    expect(firstWriteArg.symbols[0].resolvedSubSectors).toEqual([]);
  });

  it("skips a bucket already locked by another process without counting it as an attempt", async () => {
    mockedAcquireBucketLock.mockResolvedValueOnce(false); // first bucket only

    await processUniverseRefresh(makeJob());

    expect(mockedFetchScreenerBucket).toHaveBeenCalledTimes(TOTAL_BUCKETS - 1);
    expect(mockedRecordRefreshSuccess).toHaveBeenCalledTimes(1);
  });

  it("records an aggregate success (not failure) when only some buckets fail", async () => {
    mockedFetchScreenerBucket.mockRejectedValueOnce(
      new Error("EODHD rate limited"),
    );

    await processUniverseRefresh(makeJob());

    // One bucket failed, the rest succeeded — a lucky/partial success must not
    // be mistaken for total failure. Aggregate outcome is success.
    expect(mockedRecordRefreshSuccess).toHaveBeenCalledTimes(1);
    expect(mockedRecordRefreshFailure).not.toHaveBeenCalled();
  });

  it("records an aggregate failure once when every attempted bucket fails, without opening the breaker below threshold", async () => {
    mockedFetchScreenerBucket.mockRejectedValue(new Error("EODHD unreachable"));
    mockedRecordRefreshFailure.mockResolvedValue({ justOpened: false });

    await processUniverseRefresh(makeJob());

    expect(mockedRecordRefreshFailure).toHaveBeenCalledTimes(1);
    expect(mockedRecordRefreshSuccess).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("fires exactly one Sentry alert with the eodhd_outage_sustained fingerprint when the breaker just opened", async () => {
    mockedFetchScreenerBucket.mockRejectedValue(new Error("EODHD unreachable"));
    mockedRecordRefreshFailure.mockResolvedValue({ justOpened: true });

    await processUniverseRefresh(makeJob());

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("circuit breaker opened"),
      expect.objectContaining({
        level: "error",
        fingerprint: ["eodhd_outage_sustained"],
      }),
    );
  });
});
