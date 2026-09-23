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

jest.mock("../../lib/bucket-fetch", () => ({
  fetchBucketSymbols: jest.fn(),
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

jest.mock("../../queues/universe-refresh.queue", () => ({
  universeRefreshQueue: { add: jest.fn() },
}));

import * as Sentry from "@sentry/node";
import type { Job } from "bullmq";
import {
  ALLOWED_SECTORS,
  MarketCapTier,
} from "@tachyonapp/tachyon-queue-types";
import type { UniverseRefreshJobPayload } from "@tachyonapp/tachyon-queue-types";
import { processUniverseRefresh } from "../universe-refresh.worker";
import * as bucketFetch from "../../lib/bucket-fetch";
import * as universeCache from "../../lib/universe-cache";
import { universeRefreshQueue } from "../../queues/universe-refresh.queue";

const TOTAL_BUCKETS =
  ALLOWED_SECTORS.length * Object.values(MarketCapTier).length;

function makeJob(targetBucketKey?: string): Job<UniverseRefreshJobPayload> {
  return {
    data: { triggeredAt: new Date().toISOString(), targetBucketKey },
  } as Job<UniverseRefreshJobPayload>;
}

const mockedFetchBucketSymbols = bucketFetch.fetchBucketSymbols as jest.Mock;
const mockedReadBreakerState = universeCache.readBreakerState as jest.Mock;
const mockedRecordRefreshSuccess =
  universeCache.recordRefreshSuccess as jest.Mock;
const mockedRecordRefreshFailure =
  universeCache.recordRefreshFailure as jest.Mock;
const mockedAcquireBucketLock = universeCache.acquireBucketLock as jest.Mock;
const mockedWriteBucket = universeCache.writeBucket as jest.Mock;
const mockedQueueAdd = universeRefreshQueue.add as jest.Mock;

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
    mockedFetchBucketSymbols.mockResolvedValue([
      {
        symbol: "AAPL",
        parentSector: "Technology",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        resolvedSubSectors: ["Consumer Electronics"],
        dividendYield: 0.005,
        shortInterestPct: 0.01,
        nextEarningsDate: null, // no-trigger by default; DEV-9 tests override this
        price: 190,
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
    expect(mockedFetchBucketSymbols).not.toHaveBeenCalled();
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

    expect(mockedFetchBucketSymbols).not.toHaveBeenCalled();
    expect(mockedAcquireBucketLock).not.toHaveBeenCalled();
  });

  it("attempts every bucket, writes each one, and records a single aggregate success when all succeed", async () => {
    await processUniverseRefresh(makeJob());

    expect(mockedFetchBucketSymbols).toHaveBeenCalledTimes(TOTAL_BUCKETS);
    expect(mockedWriteBucket).toHaveBeenCalledTimes(TOTAL_BUCKETS);
    expect(mockedRecordRefreshSuccess).toHaveBeenCalledTimes(1);
    expect(mockedRecordRefreshFailure).not.toHaveBeenCalled();
  });

  it("writes the resolvedSubSectors bucket-fetch already resolved, without re-deriving them", async () => {
    await processUniverseRefresh(makeJob());

    const firstWriteArg = mockedWriteBucket.mock.calls[0][0];
    expect(firstWriteArg.symbols[0].resolvedSubSectors).toEqual([
      "Consumer Electronics",
    ]);
  });

  it("skips a bucket already locked by another process without counting it as an attempt", async () => {
    mockedAcquireBucketLock.mockResolvedValueOnce(false); // first bucket only

    await processUniverseRefresh(makeJob());

    expect(mockedFetchBucketSymbols).toHaveBeenCalledTimes(TOTAL_BUCKETS - 1);
    expect(mockedRecordRefreshSuccess).toHaveBeenCalledTimes(1);
  });

  it("records an aggregate success (not failure) when only some buckets fail", async () => {
    mockedFetchBucketSymbols.mockRejectedValueOnce(
      new Error("EODHD rate limited"),
    );

    await processUniverseRefresh(makeJob());

    // One bucket failed, the rest succeeded — a lucky/partial success must not
    // be mistaken for total failure. Aggregate outcome is success.
    expect(mockedRecordRefreshSuccess).toHaveBeenCalledTimes(1);
    expect(mockedRecordRefreshFailure).not.toHaveBeenCalled();
  });

  it("records an aggregate failure once when every attempted bucket fails, without opening the breaker below threshold", async () => {
    mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));
    mockedRecordRefreshFailure.mockResolvedValue({ justOpened: false });

    await processUniverseRefresh(makeJob());

    expect(mockedRecordRefreshFailure).toHaveBeenCalledTimes(1);
    expect(mockedRecordRefreshSuccess).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("fires exactly one Sentry alert with the eodhd_outage_sustained fingerprint when the breaker just opened", async () => {
    mockedFetchBucketSymbols.mockRejectedValue(new Error("EODHD unreachable"));
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

describe("processUniverseRefresh — out-of-band earnings trigger (DEV-9)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, UNIVERSE_REFRESH_ENABLED: "true" };
    mockedAcquireBucketLock.mockResolvedValue(true);
    mockedReadBreakerState.mockResolvedValue(CLOSED_BREAKER);
    // Non-triggering baseline for every bucket — individual tests override
    // just the FIRST call (mockResolvedValueOnce) so only one of the 44
    // buckets in a full sweep is expected to trigger, keeping assertions exact.
    mockedFetchBucketSymbols.mockResolvedValue([
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
    ]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("enqueues an out-of-band refresh when a symbol's nextEarningsDate is inside the lookahead window", async () => {
    process.env.EARNINGS_REFRESH_LOOKAHEAD_HOURS = "24";
    mockedFetchBucketSymbols.mockResolvedValueOnce([
      {
        symbol: "AAPL",
        parentSector: "Technology",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        resolvedSubSectors: ["Consumer Electronics"],
        dividendYield: null,
        shortInterestPct: null,
        nextEarningsDate: new Date(
          Date.now() + 12 * 60 * 60 * 1000,
        ).toISOString(),
        price: 190,
      },
    ]);

    await processUniverseRefresh(makeJob());

    expect(mockedQueueAdd).toHaveBeenCalledTimes(1);
    const [, payload] = mockedQueueAdd.mock.calls[0];
    expect(payload.targetBucketKey).toBe("Technology:MEGA_CAP");
  });

  it("does not enqueue an out-of-band refresh when nextEarningsDate is outside the lookahead window", async () => {
    process.env.EARNINGS_REFRESH_LOOKAHEAD_HOURS = "24";
    mockedFetchBucketSymbols.mockResolvedValueOnce([
      {
        symbol: "AAPL",
        parentSector: "Technology",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        resolvedSubSectors: ["Consumer Electronics"],
        dividendYield: null,
        shortInterestPct: null,
        nextEarningsDate: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        price: 190,
      },
    ]);

    await processUniverseRefresh(makeJob());

    expect(mockedQueueAdd).not.toHaveBeenCalled();
  });

  it("never runs the earnings check or enqueues anything during a targeted (out-of-band) run — prevents an infinite self-triggering loop", async () => {
    mockedFetchBucketSymbols.mockResolvedValue([
      {
        symbol: "AAPL",
        parentSector: "Technology",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        resolvedSubSectors: ["Consumer Electronics"],
        dividendYield: null,
        shortInterestPct: null,
        // Still imminent — if the guard were missing, this would re-enqueue itself forever.
        nextEarningsDate: new Date(
          Date.now() + 1 * 60 * 60 * 1000,
        ).toISOString(),
        price: 190,
      },
    ]);

    await processUniverseRefresh(makeJob("Technology:MEGA_CAP"));

    expect(mockedQueueAdd).not.toHaveBeenCalled();
  });

  it("a targeted run only processes the one specified bucket, not the full universe", async () => {
    await processUniverseRefresh(makeJob("Technology:MEGA_CAP"));

    expect(mockedFetchBucketSymbols).toHaveBeenCalledTimes(1);
    expect(mockedFetchBucketSymbols).toHaveBeenCalledWith(
      "Technology",
      "MEGA_CAP",
    );
  });
});
