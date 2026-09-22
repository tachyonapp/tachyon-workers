// Market Scanning Universe Filtering Cache
// =============================================================================
// PURPOSE
// =============================================================================
// Owns ALL raw Valkey key construction/parsing for Market Scanning
// & Universe Filtering. No other file should hand-construct a
// `universe:bucket:*`, `universe:breaker`, or `universe:lock:*` key string.
// Used by universe-refresh.worker.ts (writer) and scan-bot.worker.ts
// (reader).
//
// Bucket and breaker hashes carry NO TTL — freshness is enforced by the
// scan-side staleness gate comparing asOf/expiresAt fields against wall-clock
// time, not by Valkey key expiry. A worker restart mid-outage must not
// silently reset the breaker. Only the per-bucket lock key has a TTL.
//
// No shared raw-ioredis client exists elsewhere in this codebase to reuse
// (connection.ts is BullMQ-only config; heartbeat.ts opens its own one-off
// client for a single long-lived instance). This module follows the same
// VALKEY_HOST/PORT/PASSWORD/TLS config shape but keeps its own lazily-created
// singleton, since it's called far more frequently than a once-per-process
// heartbeat.
// =============================================================================
import { Redis as ValKey } from "ioredis";
import type {
  MarketCapTier,
  MarketDataTier,
  UniverseBucketCacheEntry,
  CircuitBreakerState,
  CircuitBreakerHashState,
} from "@tachyonapp/tachyon-queue-types";

const BREAKER_KEY = "universe:breaker";

let client: ValKey | undefined;

function getClient(): ValKey {
  if (!client) {
    client = new ValKey({
      host: process.env.VALKEY_HOST || "localhost",
      port: parseInt(process.env.VALKEY_PORT || "6379", 10),
      password: process.env.VALKEY_PASSWORD || undefined,
      tls: process.env.VALKEY_TLS === "true" ? {} : undefined,
    });
  }
  return client;
}

export function bucketCacheKey(
  parentSector: string,
  marketCapTier: MarketCapTier,
): string {
  return `universe:bucket:${parentSector}:${marketCapTier}`;
}

function bucketLockKey(bucketKey: string): string {
  return `universe:lock:${bucketKey}`;
}

// --- Bucket cache ---

export async function writeBucket(
  entry: UniverseBucketCacheEntry,
): Promise<void> {
  const valkey = getClient();
  await valkey.hset(entry.bucketKey, {
    asOf: entry.asOf,
    expiresAt: entry.expiresAt,
    tier: entry.tier,
    payload: JSON.stringify(entry.symbols),
  });
}

export async function readBucket(
  parentSector: string,
  marketCapTier: MarketCapTier,
): Promise<UniverseBucketCacheEntry | null> {
  const valkey = getClient();
  const bucketKey = bucketCacheKey(parentSector, marketCapTier);
  const hash = await valkey.hgetall(bucketKey);

  if (!hash || Object.keys(hash).length === 0) return null;

  return {
    bucketKey,
    asOf: hash.asOf,
    expiresAt: hash.expiresAt,
    tier: hash.tier as MarketDataTier,
    symbols: JSON.parse(hash.payload) as UniverseBucketCacheEntry["symbols"],
  };
}

// --- Circuit breaker ---

function parseBreakerHash(
  hash: Record<string, string>,
): CircuitBreakerHashState {
  if (!hash || Object.keys(hash).length === 0) {
    return {
      state: "CLOSED",
      consecutiveFailures: 0,
      openedAt: null,
      nextRetryAt: null,
      lastSuccessAt: null,
    };
  }
  return {
    state: (hash.state as CircuitBreakerState) || "CLOSED",
    consecutiveFailures: parseInt(hash.consecutiveFailures, 10) || 0,
    openedAt: hash.openedAt || null,
    nextRetryAt: hash.nextRetryAt || null,
    lastSuccessAt: hash.lastSuccessAt || null,
  };
}

export async function readBreakerState(): Promise<CircuitBreakerHashState> {
  const valkey = getClient();
  const hash = await valkey.hgetall(BREAKER_KEY);
  return parseBreakerHash(hash);
}

export async function recordRefreshSuccess(): Promise<void> {
  const valkey = getClient();
  await valkey.hset(BREAKER_KEY, {
    state: "CLOSED",
    consecutiveFailures: "0",
    openedAt: "",
    nextRetryAt: "",
    lastSuccessAt: new Date().toISOString(),
  });
}

/**
 * Increments the consecutive-failure counter and opens the breaker once it
 * crosses failureThreshold. `justOpened` is true ONLY on the CLOSED→OPEN
 * transition — the caller (DEV-8) must fire its Sentry outage alert exactly
 * once per outage episode, guarded by this flag, not on every failed tick
 * while already open.
 *
 * While already OPEN, a subsequent failure (a retry attempted once the prior
 * backoff window elapsed) advances nextRetryAt using the next step of
 * backoffScheduleSeconds, capped at the schedule's last entry. openedAt is
 * preserved across the whole episode.
 */
export async function recordRefreshFailure(
  failureThreshold: number,
  backoffScheduleSeconds: number[],
): Promise<{ justOpened: boolean }> {
  const valkey = getClient();
  const current = await readBreakerState();
  const consecutiveFailures = current.consecutiveFailures + 1;
  const wasOpen = current.state === "OPEN";

  if (!wasOpen && consecutiveFailures < failureThreshold) {
    await valkey.hset(BREAKER_KEY, {
      state: "CLOSED",
      consecutiveFailures: String(consecutiveFailures),
      openedAt: "",
      nextRetryAt: "",
      lastSuccessAt: current.lastSuccessAt ?? "",
    });
    return { justOpened: false };
  }

  const backoffIndex = Math.min(
    Math.max(consecutiveFailures - failureThreshold, 0),
    backoffScheduleSeconds.length - 1,
  );
  const backoffSeconds = backoffScheduleSeconds[backoffIndex] ?? 300;
  const now = new Date();
  const nextRetryAt = new Date(now.getTime() + backoffSeconds * 1000);

  await valkey.hset(BREAKER_KEY, {
    state: "OPEN",
    consecutiveFailures: String(consecutiveFailures),
    openedAt: wasOpen ? current.openedAt! : now.toISOString(),
    nextRetryAt: nextRetryAt.toISOString(),
    lastSuccessAt: current.lastSuccessAt ?? "",
  });

  return { justOpened: !wasOpen };
}

// --- Single-flight lock ---

export async function acquireBucketLock(
  bucketKey: string,
  ttlSeconds: number,
): Promise<boolean> {
  const valkey = getClient();
  const result = await valkey.set(
    bucketLockKey(bucketKey),
    String(process.pid),
    "EX",
    ttlSeconds,
    "NX",
  );
  return result === "OK";
}

export async function releaseBucketLock(bucketKey: string): Promise<void> {
  const valkey = getClient();
  await valkey.del(bucketLockKey(bucketKey));
}
