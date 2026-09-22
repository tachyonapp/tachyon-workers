/**
 * Universe Filter Chain
 *
 * Pure, deterministic functions — NO network I/O, no Valkey/DB access -
 * filters the cached universe of candidate symbols down to what's eligible for
 * a given bot. Fixed stage order, NEVER reorderable by agent
 *
 * configuration:
 *
 *   asset type → sector/sub-sector → market cap → liquidity →
 *   earnings exclusion → dividend preference → watchlist/exclusion →
 *   short-interest
 *
 * every function here must be a pure function of its inputs. No AI/ML
 * calls, no adaptive/learned thresholds, no brain-router.ts calls — flag in
 * review if any stage's logic looks like it's approximating a threshold
 * rather than applying a fixed, configured one.
 *
 * Called by scan-bot.worker.ts, which assembles `candidateSymbols`
 * as the union of all bucket(s) relevant to the agent's sub_sectors before
 * calling runFilterChain() once.
 */
import {
  MarketCapTier,
  LiquidityTier,
  DividendPreference,
  ShortInterestSignal,
  EarningsBehavior,
  ALLOWED_SECTORS,
  TIER_B_SUB_SECTORS,
  PLATFORM_LIMITS,
  MARKET_CAP_TIER_USD_BANDS,
  LIQUIDITY_TIER_MIN_ADV_USD,
  type UniverseBucketSymbolEntry,
} from "@tachyonapp/tachyon-queue-types";

// Per Brock's product decision (2026-09-22) — see the Feature 10 TDD's Open
// Questions section, "Earnings-calendar exclusion window". Deliberately
// distinct from EARNINGS_REFRESH_LOOKAHEAD_HOURS (DEV-9): that var gates a
// data-freshness refresh trigger; this one gates a trading-risk exclusion.
function getEarningsStandDownWindowDays(): number {
  return Number(
    process.env.UNIVERSE_FILTER_EARNINGS_STANDDOWN_WINDOW_DAYS ?? 5,
  );
}

// Per Brock's product decision (2026-09-22) — see the Feature 10 TDD's Open
// Questions section, "Short-interest signal filter". Same threshold reused in
// both directions (AVOID excludes above it, TARGET_SHORT_SQUEEZE requires
// above it) rather than two independently-tuned numbers — deliberate, not an
// oversight, given EODHD ShareStats' own accepted lower-fidelity tradeoff.
function getShortInterestHighThresholdPct(): number {
  return Number(
    process.env.UNIVERSE_FILTER_SHORT_INTEREST_HIGH_THRESHOLD_PCT ?? 20,
  );
}

export interface FilterChainInput {
  botSettings: {
    subSectors: string[]; // bot_settings.sub_sectors, hydrated JSONB
    customWatchlist: string[];
    exclusionList: string[];
    dividendPreference: DividendPreference;
    shortInterestSignal: ShortInterestSignal;
    earningsBehavior: EarningsBehavior;
  };
  frameMarketCapTiers: MarketCapTier[]; // resolved from FRAME_CONFIG[frameName].defaults.marketCapTiers
  frameLiquidityTier: LiquidityTier;
  candidateSymbols: UniverseBucketSymbolEntry[]; // union of all bucket(s) relevant to the agent's sub_sectors
}

export interface FilterChainOutput {
  candidates: Array<{
    symbol: string;
    marketDataSnapshot: UniverseBucketSymbolEntry;
  }>;
}

// --- Stage 1: Asset type ---------------------------------------------------
//
// No assetType field exists on UniverseBucketSymbolEntry: the bucket-fetch
// pipeline (DEV-6's GICS-sector-based EODHD Screener query, run per DEV-8)
// only ever returns GICS-classified individual equities — ETFs, which have
// no GICS sector classification, are structurally excluded upstream by
// construction, not filtered here. This stage is a documented pass-through
// rather than an omitted one, so the fixed 8-stage order stays intact and
// self-evident in review, and so a future assetType field (if the data model
// ever needs one) has an obvious, already-ordered place to plug into.
function filterAssetType(
  candidates: UniverseBucketSymbolEntry[],
): UniverseBucketSymbolEntry[] {
  return candidates;
}

// --- Stage 2: Sector / sub-sector -------------------------------------------

function resolveParentSector(subSectorLabel: string): string | undefined {
  return ALLOWED_SECTORS.find((s) => s.subSectors.includes(subSectorLabel))
    ?.parentSector;
}

function filterSectorSubSector(
  candidates: UniverseBucketSymbolEntry[],
  subSectors: string[],
): UniverseBucketSymbolEntry[] {
  if (subSectors.length === 0) return candidates;

  const tierBParentSectors = new Set<string>();
  const tierALabels = new Set<string>();

  for (const label of subSectors) {
    if (TIER_B_SUB_SECTORS.includes(label)) {
      const parentSector = resolveParentSector(label);
      // Every Tier B label lives under some ALLOWED_SECTORS parent sector by
      // construction — undefined here means a malformed/stale bot_settings
      // value. Skip it rather than throw and abort the whole scan cycle over
      // one bad sub-sector entry.
      if (parentSector) tierBParentSectors.add(parentSector);
    } else {
      tierALabels.add(label);
    }
  }

  return candidates.filter((c) => {
    // Tier B match is parent-sector-only, regardless of resolvedSubSectors —
    // Tier B entries have an empty resolvedSubSectors by design (DEV-8: no
    // GICS_SUB_SECTOR_MAP entry exists for them), so this never attempts a
    // map lookup for a Tier B label.
    if (tierBParentSectors.has(c.parentSector)) return true;
    return c.resolvedSubSectors.some((label) => tierALabels.has(label));
  });
}

// --- Stage 3: Market cap -----------------------------------------------------

function filterMarketCap(
  candidates: UniverseBucketSymbolEntry[],
  frameMarketCapTiers: MarketCapTier[],
): UniverseBucketSymbolEntry[] {
  return candidates.filter((c) => {
    // Absolute floor always applies, underneath every frame's tier — including SURGE.
    if (c.marketCapUsd < PLATFORM_LIMITS.minMarketCapUsd) return false;

    return frameMarketCapTiers.some((tier) => {
      const band = MARKET_CAP_TIER_USD_BANDS[tier];
      return (
        c.marketCapUsd >= band.min &&
        (band.max === undefined || c.marketCapUsd < band.max)
      );
    });
  });
}

// --- Stage 4: Liquidity -------------------------------------------------------

function filterLiquidity(
  candidates: UniverseBucketSymbolEntry[],
  frameLiquidityTier: LiquidityTier,
): UniverseBucketSymbolEntry[] {
  // Absolute floor always applies, underneath every frame's tier.
  const minAvgDollarVolume = Math.max(
    LIQUIDITY_TIER_MIN_ADV_USD[frameLiquidityTier],
    PLATFORM_LIMITS.minAvgDollarVolumeUsd,
  );
  return candidates.filter((c) => c.avgDollarVolume >= minAvgDollarVolume);
}

// --- Stage 5: Earnings exclusion ---------------------------------------------

function filterEarningsExclusion(
  candidates: UniverseBucketSymbolEntry[],
  earningsBehavior: EarningsBehavior,
): UniverseBucketSymbolEntry[] {
  // NEUTRAL and MORE_AGGRESSIVE: no exclusion at this filter-chain stage —
  // per Brock's product decision (2026-09-22, TDD Open Questions). Any real
  // differentiation for MORE_AGGRESSIVE is a Feature 11 scoring concern that
  // doesn't exist yet, not something this deterministic binary gate should encode.
  if (earningsBehavior !== EarningsBehavior.STAND_DOWN) return candidates;

  const cutoffMs =
    Date.now() + getEarningsStandDownWindowDays() * 24 * 60 * 60 * 1000;

  return candidates.filter((c) => {
    if (!c.nextEarningsDate) return true; // unknown — never excluded on a data gap
    return new Date(c.nextEarningsDate).getTime() > cutoffMs;
  });
}

// --- Stage 6: Dividend preference --------------------------------------------

function filterDividendPreference(
  candidates: UniverseBucketSymbolEntry[],
  dividendPreference: DividendPreference,
): UniverseBucketSymbolEntry[] {
  switch (dividendPreference) {
    case DividendPreference.PREFER_DIVIDEND:
      return candidates.filter((c) => (c.dividendYield ?? 0) > 0);
    case DividendPreference.EXCLUDE_DIVIDEND:
      return candidates.filter((c) => !c.dividendYield);
    case DividendPreference.NO_PREFERENCE:
    default:
      return candidates;
  }
}

// --- Stage 7: Watchlist / exclusion ------------------------------------------

function filterExclusionList(
  candidates: UniverseBucketSymbolEntry[],
  exclusionList: string[],
): UniverseBucketSymbolEntry[] {
  if (exclusionList.length === 0) return candidates;
  const excluded = new Set(exclusionList);
  return candidates.filter((c) => !excluded.has(c.symbol));
}

// FR8: customWatchlist tickers are prioritized ahead of, not merely included
// in, the broader filtered universe — a re-ordering step, not an inclusion
// filter. A watchlist ticker must still have passed every prior stage to
// appear here at all; it is not exempt from sector/cap/liquidity/earnings/
// dividend filtering.
function prioritizeWatchlist(
  candidates: UniverseBucketSymbolEntry[],
  customWatchlist: string[],
): UniverseBucketSymbolEntry[] {
  if (customWatchlist.length === 0) return candidates;

  const watchlisted = new Set(customWatchlist);
  const front: UniverseBucketSymbolEntry[] = [];
  const rest: UniverseBucketSymbolEntry[] = [];

  for (const c of candidates) {
    (watchlisted.has(c.symbol) ? front : rest).push(c);
  }

  return [...front, ...rest];
}

// --- Stage 8: Short-interest --------------------------------------------------
//
// Per Brock's product decision (2026-09-22, TDD Open Questions → "Short-interest
// signal filter"): AVOID_HIGH_SHORT_INTEREST excludes above the threshold;
// TARGET_SHORT_SQUEEZE requires strictly above the same threshold to be
// included at all (deliberately not treated like MORE_AGGRESSIVE's no-op —
// "target squeeze candidates" has a direct binary-filter reading, so leaving
// it identical to IGNORE would understate what the enum value promises).
function filterShortInterest(
  candidates: UniverseBucketSymbolEntry[],
  shortInterestSignal: ShortInterestSignal,
): UniverseBucketSymbolEntry[] {
  if (shortInterestSignal === ShortInterestSignal.IGNORE) return candidates;

  // shortInterestPct is stored as a fraction (e.g. 0.05 = 5%), matching
  // dividendYield's convention — the threshold is expressed in percentage
  // points (default 20 = 20%), so convert before comparing.
  const thresholdFraction = getShortInterestHighThresholdPct() / 100;

  if (shortInterestSignal === ShortInterestSignal.AVOID_HIGH_SHORT_INTEREST) {
    return candidates.filter((c) => {
      if (c.shortInterestPct === null) return true; // unknown — never excluded on a data gap
      return c.shortInterestPct <= thresholdFraction;
    });
  }

  // TARGET_SHORT_SQUEEZE: unlike AVOID above, a null shortInterestPct fails
  // this inclusion test rather than passing through — "can't confirm it meets
  // the stated criteria," the expected asymmetry between an avoid-gate
  // (defaults to include on missing data) and a target-gate (defaults to
  // exclude), per Brock's decision.
  return candidates.filter(
    (c) =>
      c.shortInterestPct !== null && c.shortInterestPct > thresholdFraction,
  );
}

export function runFilterChain(input: FilterChainInput): FilterChainOutput {
  const { botSettings, frameMarketCapTiers, frameLiquidityTier } = input;

  let candidates = input.candidateSymbols;
  candidates = filterAssetType(candidates);
  candidates = filterSectorSubSector(candidates, botSettings.subSectors);
  candidates = filterMarketCap(candidates, frameMarketCapTiers);
  candidates = filterLiquidity(candidates, frameLiquidityTier);
  candidates = filterEarningsExclusion(
    candidates,
    botSettings.earningsBehavior,
  );
  candidates = filterDividendPreference(
    candidates,
    botSettings.dividendPreference,
  );
  candidates = filterExclusionList(candidates, botSettings.exclusionList);
  candidates = prioritizeWatchlist(candidates, botSettings.customWatchlist);
  candidates = filterShortInterest(candidates, botSettings.shortInterestSignal);

  return {
    candidates: candidates.map((c) => ({
      symbol: c.symbol,
      marketDataSnapshot: c,
    })),
  };
}
