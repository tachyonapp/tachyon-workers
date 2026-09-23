/**
 * Bucket Fetch
 *
 * The sole module (besides eodhd-client.ts itself) permitted to import
 * eodhd-client.ts. Shared by universe-refresh.worker.ts
 * and scan-bot.worker.ts's staleness-gate bounded refresh —
 * this is what lets scan-bot.worker.ts stay compliant ("scan-bot
 * never calls EODHD directly") without duplicating the fetch/translate/build
 * logic in two places, which would risk the two copies silently drifting
 * apart (the same category of risk MARKET_CAP_TIER_USD_BANDS was extracted
 * to avoid — see tachyon-queue-types).
 *
 * Pure fetch + GICS-label translation + UniverseBucketSymbolEntry construction
 * only — no locking, no cache write, no out-of-band trigger logic. Callers
 * own locking (universe-cache.ts's acquireBucketLock) and writeBucket()
 * themselves, since their surrounding timeout/retry contexts differ
 * (cadence-driven full sweep vs. a bounded, timeout-wrapped single-bucket
 * refresh).
 */
import {
  GICS_SUB_SECTOR_MAP,
  type MarketCapTier,
  type UniverseBucketSymbolEntry,
} from "@tachyonapp/tachyon-queue-types";
import { fetchScreenerBucket, fetchFundamentals } from "./eodhd-client";

export async function fetchBucketSymbols(
  parentSector: string,
  marketCapTier: MarketCapTier,
): Promise<UniverseBucketSymbolEntry[]> {
  const screenerResults = await fetchScreenerBucket({
    parentSector,
    marketCapTier,
  });
  const fundamentals = await fetchFundamentals(
    screenerResults.map((r) => r.symbol),
  );
  const fundamentalsBySymbol = new Map(fundamentals.map((f) => [f.symbol, f]));

  return screenerResults.map((r) => {
    const fund = fundamentalsBySymbol.get(r.symbol);
    // No map entry (Tier B / unclassified) resolves to an empty array, not an error.
    const resolvedLabel = GICS_SUB_SECTOR_MAP[r.gicsSubIndustry];
    return {
      symbol: r.symbol,
      parentSector,
      marketCapUsd: r.marketCapUsd,
      avgDollarVolume: r.avgDollarVolume,
      resolvedSubSectors: resolvedLabel ? [resolvedLabel] : [],
      dividendYield: fund?.dividendYield ?? null,
      shortInterestPct: fund?.shortInterestPct ?? null,
      nextEarningsDate: fund?.nextEarningsDate ?? null,
      price: r.price,
    };
  });
}
