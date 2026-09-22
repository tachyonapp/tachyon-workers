import { MarketCapTier } from "@tachyonapp/tachyon-queue-types";

// In-memory fake standing in for ioredis — gives genuine round-trip behavior
// (HSET/HGETALL, SET NX EX) rather than mocking outputs to match inputs.
class FakeRedis {
  private hashes = new Map<string, Record<string, string>>();
  private strings = new Map<string, { value: string; expiresAt?: number }>();

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    const existing = this.hashes.get(key) ?? {};
    this.hashes.set(key, { ...existing, ...fields });
    return Object.keys(fields).length;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.hashes.get(key) ?? {};
  }

  async set(
    key: string,
    value: string,
    ...args: string[]
  ): Promise<"OK" | null> {
    const nx = args.includes("NX");
    if (nx && this.strings.has(key) && !this.isExpired(key)) return null;

    const exIndex = args.indexOf("EX");
    const ttlSeconds = exIndex >= 0 ? Number(args[exIndex + 1]) : undefined;
    this.strings.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    const hadHash = this.hashes.delete(key);
    const hadString = this.strings.delete(key);
    return hadHash || hadString ? 1 : 0;
  }

  private isExpired(key: string): boolean {
    const entry = this.strings.get(key);
    if (!entry?.expiresAt) return false;
    return Date.now() > entry.expiresAt;
  }
}

jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => new FakeRedis()),
}));

// Each test gets a fresh module registry — and therefore a fresh FakeRedis
// singleton inside universe-cache.ts — so tests never leak state into each other.
function loadUniverseCache(): typeof import("../universe-cache") {
  let mod: typeof import("../universe-cache");
  jest.isolateModules(() => {
    // jest.isolateModules requires a synchronous require() to get a fresh
    // module instance per test — a static import would be hoisted once.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../universe-cache");
  });
  return mod!;
}

describe("bucketCacheKey", () => {
  it("formats as universe:bucket:<parentSector>:<marketCapTier>", () => {
    const { bucketCacheKey } = loadUniverseCache();
    expect(bucketCacheKey("TECHNOLOGY", MarketCapTier.MEGA_CAP)).toBe(
      "universe:bucket:TECHNOLOGY:MEGA_CAP",
    );
  });
});

describe("writeBucket / readBucket", () => {
  it("round-trips a bucket entry", async () => {
    const { bucketCacheKey, writeBucket, readBucket } = loadUniverseCache();
    const bucketKey = bucketCacheKey("TECHNOLOGY", MarketCapTier.MEGA_CAP);

    await writeBucket({
      bucketKey,
      asOf: "2026-09-21T14:00:00.000Z",
      expiresAt: "2026-09-21T14:05:00.000Z",
      tier: "FAST",
      symbols: [
        {
          symbol: "AAPL",
          parentSector: "TECHNOLOGY",
          marketCapUsd: 3_000_000_000_000,
          avgDollarVolume: 9_500_000_000,
          resolvedSubSectors: ["Consumer Electronics"],
          dividendYield: 0.005,
          shortInterestPct: 0.01,
          nextEarningsDate: "2026-10-30",
          price: 190,
        },
      ],
    });

    const result = await readBucket("TECHNOLOGY", MarketCapTier.MEGA_CAP);

    expect(result).toEqual({
      bucketKey,
      asOf: "2026-09-21T14:00:00.000Z",
      expiresAt: "2026-09-21T14:05:00.000Z",
      tier: "FAST",
      symbols: [
        {
          symbol: "AAPL",
          parentSector: "TECHNOLOGY",
          marketCapUsd: 3_000_000_000_000,
          avgDollarVolume: 9_500_000_000,
          resolvedSubSectors: ["Consumer Electronics"],
          dividendYield: 0.005,
          shortInterestPct: 0.01,
          nextEarningsDate: "2026-10-30",
          price: 190,
        },
      ],
    });
  });

  it("returns null for a bucket that was never written", async () => {
    const { readBucket } = loadUniverseCache();
    const result = await readBucket("ENERGY", MarketCapTier.MID_CAP);
    expect(result).toBeNull();
  });
});

describe("circuit breaker", () => {
  it("defaults to CLOSED with zero failures when never written", async () => {
    const { readBreakerState } = loadUniverseCache();
    const state = await readBreakerState();
    expect(state).toEqual({
      state: "CLOSED",
      consecutiveFailures: 0,
      openedAt: null,
      nextRetryAt: null,
      lastSuccessAt: null,
    });
  });

  it("opens exactly once when consecutive failures cross the threshold", async () => {
    const { recordRefreshFailure, readBreakerState } = loadUniverseCache();

    const first = await recordRefreshFailure(3, [300, 900, 1800]);
    expect(first.justOpened).toBe(false);
    const second = await recordRefreshFailure(3, [300, 900, 1800]);
    expect(second.justOpened).toBe(false);
    const third = await recordRefreshFailure(3, [300, 900, 1800]);
    expect(third.justOpened).toBe(true);

    const state = await readBreakerState();
    expect(state.state).toBe("OPEN");
    expect(state.consecutiveFailures).toBe(3);
    expect(state.openedAt).not.toBeNull();
    expect(state.nextRetryAt).not.toBeNull();
  });

  it("stays OPEN on subsequent failures with justOpened: false, advancing the backoff", async () => {
    const { recordRefreshFailure, readBreakerState } = loadUniverseCache();

    await recordRefreshFailure(3, [300, 900, 1800]);
    await recordRefreshFailure(3, [300, 900, 1800]);
    const opened = await recordRefreshFailure(3, [300, 900, 1800]);
    expect(opened.justOpened).toBe(true);

    const stateAfterOpen = await readBreakerState();
    const openedAt = stateAfterOpen.openedAt;

    const fourth = await recordRefreshFailure(3, [300, 900, 1800]);
    expect(fourth.justOpened).toBe(false);

    const stateAfterFourth = await readBreakerState();
    expect(stateAfterFourth.state).toBe("OPEN");
    expect(stateAfterFourth.consecutiveFailures).toBe(4);
    // openedAt must not reset while already open
    expect(stateAfterFourth.openedAt).toBe(openedAt);
    // backoff should have advanced from 300s (index 0) to 900s (index 1)
    const nextRetryDeltaSeconds =
      (new Date(stateAfterFourth.nextRetryAt!).getTime() - Date.now()) / 1000;
    expect(nextRetryDeltaSeconds).toBeGreaterThan(800);
    expect(nextRetryDeltaSeconds).toBeLessThan(1000);
  });

  it("closes the breaker on a successful refresh after it was open", async () => {
    const { recordRefreshFailure, recordRefreshSuccess, readBreakerState } =
      loadUniverseCache();

    await recordRefreshFailure(3, [300, 900, 1800]);
    await recordRefreshFailure(3, [300, 900, 1800]);
    await recordRefreshFailure(3, [300, 900, 1800]);
    expect((await readBreakerState()).state).toBe("OPEN");

    await recordRefreshSuccess();

    const state = await readBreakerState();
    expect(state.state).toBe("CLOSED");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.openedAt).toBeNull();
    expect(state.nextRetryAt).toBeNull();
    expect(state.lastSuccessAt).not.toBeNull();
  });
});

describe("bucket lock", () => {
  it("acquires an uncontended lock and releases it", async () => {
    const { acquireBucketLock, releaseBucketLock } = loadUniverseCache();

    const acquired = await acquireBucketLock("TECHNOLOGY:MEGA_CAP", 10);
    expect(acquired).toBe(true);

    await releaseBucketLock("TECHNOLOGY:MEGA_CAP");

    const reacquired = await acquireBucketLock("TECHNOLOGY:MEGA_CAP", 10);
    expect(reacquired).toBe(true);
  });

  it("fails to acquire an already-locked bucket", async () => {
    const { acquireBucketLock } = loadUniverseCache();

    const first = await acquireBucketLock("ENERGY:LARGE_CAP", 10);
    expect(first).toBe(true);

    const second = await acquireBucketLock("ENERGY:LARGE_CAP", 10);
    expect(second).toBe(false);
  });
});
