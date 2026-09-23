import {
  MarketCapTier,
  LiquidityTier,
  DividendPreference,
  ShortInterestSignal,
  EarningsBehavior,
  FRAME_CONFIG,
  BotFrameName,
  MARKET_CAP_TIER_USD_BANDS,
  LIQUIDITY_TIER_MIN_ADV_USD,
  type UniverseBucketSymbolEntry,
} from "@tachyonapp/tachyon-queue-types";
import {
  runFilterChain,
  resolveRelevantParentSectors,
  type FilterChainInput,
} from "../universe-filter-chain";

function makeEntry(
  overrides: Partial<UniverseBucketSymbolEntry> & { symbol: string },
): UniverseBucketSymbolEntry {
  return {
    parentSector: "Technology",
    marketCapUsd: 500_000_000_000, // MEGA_CAP by default
    avgDollarVolume: 100_000_000, // PREMIUM-eligible by default
    resolvedSubSectors: ["Software & SaaS"],
    dividendYield: null,
    shortInterestPct: null,
    nextEarningsDate: null,
    price: 100,
    ...overrides,
  };
}

const baseBotSettings: FilterChainInput["botSettings"] = {
  subSectors: [],
  customWatchlist: [],
  exclusionList: [],
  dividendPreference: DividendPreference.NO_PREFERENCE,
  shortInterestSignal: ShortInterestSignal.IGNORE,
  earningsBehavior: EarningsBehavior.NEUTRAL,
};

function baseInput(
  overrides: Partial<FilterChainInput> = {},
): FilterChainInput {
  return {
    botSettings: baseBotSettings,
    frameMarketCapTiers: [MarketCapTier.MEGA_CAP],
    frameLiquidityTier: LiquidityTier.FLOOR,
    candidateSymbols: [],
    ...overrides,
  };
}

describe("Stage: sector/sub-sector", () => {
  it("passes through unfiltered when the agent has no sub-sector selections", () => {
    const candidates = [makeEntry({ symbol: "AAPL" })];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: { ...baseBotSettings, subSectors: [] },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["AAPL"]);
  });

  it("Tier A: matches candidates whose resolvedSubSectors contains the selected label", () => {
    const candidates = [
      makeEntry({ symbol: "MATCH", resolvedSubSectors: ["Software & SaaS"] }),
      makeEntry({
        symbol: "NOMATCH",
        resolvedSubSectors: ["Semiconductors & Chips"],
      }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: { ...baseBotSettings, subSectors: ["Software & SaaS"] },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["MATCH"]);
  });

  it("Tier B: resolves via parent-sector matching, never a GICS_SUB_SECTOR_MAP lookup", () => {
    // "AI & Machine Learning" is a Tier B theme under the Technology parent sector.
    const candidates = [
      makeEntry({
        symbol: "TECHCO",
        parentSector: "Technology",
        resolvedSubSectors: [], // empty by design — Tier B entries never populate this
      }),
      makeEntry({
        symbol: "ENERGYCO",
        parentSector: "Energy",
        resolvedSubSectors: [],
      }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          subSectors: ["AI & Machine Learning"],
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["TECHCO"]);
  });
});

describe("Stage: market cap", () => {
  it("keeps only candidates within one of the frame's market-cap-tier bands", () => {
    const candidates = [
      makeEntry({ symbol: "MEGA", marketCapUsd: 500_000_000_000 }),
      makeEntry({ symbol: "MID", marketCapUsd: 5_000_000_000 }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        frameMarketCapTiers: [MarketCapTier.MEGA_CAP],
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["MEGA"]);
  });

  it("enforces PLATFORM_LIMITS.minMarketCapUsd absolute floor even for a frame targeting MID_CAP (e.g. SURGE)", () => {
    const candidates = [
      makeEntry({ symbol: "BELOW_FLOOR", marketCapUsd: 500_000_000 }), // below $1B floor
      makeEntry({ symbol: "ABOVE_FLOOR", marketCapUsd: 2_500_000_000 }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        frameMarketCapTiers: [MarketCapTier.MID_CAP],
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["ABOVE_FLOOR"]);
  });
});

describe("Stage: liquidity", () => {
  it("keeps only candidates meeting the frame's liquidity tier minimum", () => {
    const candidates = [
      makeEntry({ symbol: "LIQUID", avgDollarVolume: 60_000_000 }),
      makeEntry({ symbol: "ILLIQUID", avgDollarVolume: 1_000_000 }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        frameLiquidityTier: LiquidityTier.PREMIUM,
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["LIQUID"]);
  });

  it("enforces PLATFORM_LIMITS.minAvgDollarVolumeUsd absolute floor even for FLOOR tier", () => {
    const candidates = [
      makeEntry({ symbol: "BELOW_FLOOR", avgDollarVolume: 1_000_000 }), // below $5M floor
      makeEntry({ symbol: "ABOVE_FLOOR", avgDollarVolume: 6_000_000 }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        frameLiquidityTier: LiquidityTier.FLOOR,
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["ABOVE_FLOOR"]);
  });
});

describe("Stage: earnings exclusion", () => {
  it("STAND_DOWN excludes a candidate with nextEarningsDate inside the window", () => {
    const candidates = [
      makeEntry({
        symbol: "REPORTING_SOON",
        nextEarningsDate: new Date(
          Date.now() + 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
      makeEntry({
        symbol: "REPORTING_LATER",
        nextEarningsDate: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          earningsBehavior: EarningsBehavior.STAND_DOWN,
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["REPORTING_LATER"]);
  });

  it("STAND_DOWN never excludes a candidate with an unknown nextEarningsDate", () => {
    const candidates = [
      makeEntry({ symbol: "UNKNOWN", nextEarningsDate: null }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          earningsBehavior: EarningsBehavior.STAND_DOWN,
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["UNKNOWN"]);
  });

  it.each([EarningsBehavior.NEUTRAL, EarningsBehavior.MORE_AGGRESSIVE])(
    "%s applies no earnings-based exclusion",
    (earningsBehavior) => {
      const candidates = [
        makeEntry({
          symbol: "REPORTING_TOMORROW",
          nextEarningsDate: new Date(
            Date.now() + 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
      ];
      const result = runFilterChain(
        baseInput({
          candidateSymbols: candidates,
          botSettings: { ...baseBotSettings, earningsBehavior },
        }),
      );
      expect(result.candidates.map((c) => c.symbol)).toEqual([
        "REPORTING_TOMORROW",
      ]);
    },
  );
});

describe("Stage: dividend preference", () => {
  it("PREFER_DIVIDEND keeps only candidates with a positive dividendYield", () => {
    const candidates = [
      makeEntry({ symbol: "PAYS", dividendYield: 0.02 }),
      makeEntry({ symbol: "NOPAY", dividendYield: null }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          dividendPreference: DividendPreference.PREFER_DIVIDEND,
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["PAYS"]);
  });

  it("EXCLUDE_DIVIDEND keeps only candidates with no dividendYield", () => {
    const candidates = [
      makeEntry({ symbol: "PAYS", dividendYield: 0.02 }),
      makeEntry({ symbol: "NOPAY", dividendYield: null }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          dividendPreference: DividendPreference.EXCLUDE_DIVIDEND,
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["NOPAY"]);
  });

  it("NO_PREFERENCE applies no dividend filtering", () => {
    const candidates = [
      makeEntry({ symbol: "PAYS", dividendYield: 0.02 }),
      makeEntry({ symbol: "NOPAY", dividendYield: null }),
    ];
    const result = runFilterChain(baseInput({ candidateSymbols: candidates }));
    expect(result.candidates.map((c) => c.symbol).sort()).toEqual([
      "NOPAY",
      "PAYS",
    ]);
  });
});

describe("Stage: watchlist / exclusion", () => {
  it("drops candidates on the exclusion list", () => {
    const candidates = [
      makeEntry({ symbol: "KEEP" }),
      makeEntry({ symbol: "EXCLUDED" }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: { ...baseBotSettings, exclusionList: ["EXCLUDED"] },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual(["KEEP"]);
  });

  it("prioritizes customWatchlist tickers ahead of the rest, without exempting them from earlier stages", () => {
    const candidates = [
      makeEntry({ symbol: "REGULAR_A" }),
      makeEntry({ symbol: "WATCHED" }),
      makeEntry({ symbol: "REGULAR_B" }),
      // Fails the market-cap stage — must NOT appear even though it's watchlisted.
      makeEntry({ symbol: "WATCHED_BUT_TOO_SMALL", marketCapUsd: 100_000_000 }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          customWatchlist: ["WATCHED", "WATCHED_BUT_TOO_SMALL"],
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual([
      "WATCHED",
      "REGULAR_A",
      "REGULAR_B",
    ]);
  });
});

describe("Stage: short-interest", () => {
  it("IGNORE applies no filtering", () => {
    const candidates = [
      makeEntry({ symbol: "HIGH", shortInterestPct: 0.35 }),
      makeEntry({ symbol: "LOW", shortInterestPct: 0.02 }),
      makeEntry({ symbol: "UNKNOWN", shortInterestPct: null }),
    ];
    const result = runFilterChain(baseInput({ candidateSymbols: candidates }));
    expect(result.candidates.map((c) => c.symbol).sort()).toEqual([
      "HIGH",
      "LOW",
      "UNKNOWN",
    ]);
  });

  it("AVOID_HIGH_SHORT_INTEREST excludes above the threshold, keeps at/below it, never excludes on unknown data", () => {
    const candidates = [
      makeEntry({ symbol: "TOO_HIGH", shortInterestPct: 0.25 }), // 25% > 20% threshold
      makeEntry({ symbol: "AT_THRESHOLD", shortInterestPct: 0.2 }), // exactly 20% — passes
      makeEntry({ symbol: "LOW", shortInterestPct: 0.02 }),
      makeEntry({ symbol: "UNKNOWN", shortInterestPct: null }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          shortInterestSignal: ShortInterestSignal.AVOID_HIGH_SHORT_INTEREST,
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol).sort()).toEqual([
      "AT_THRESHOLD",
      "LOW",
      "UNKNOWN",
    ]);
  });

  it("TARGET_SHORT_SQUEEZE requires strictly above the threshold, excludes on unknown data", () => {
    const candidates = [
      makeEntry({ symbol: "SQUEEZE_CANDIDATE", shortInterestPct: 0.25 }),
      makeEntry({ symbol: "AT_THRESHOLD", shortInterestPct: 0.2 }), // exactly 20% — does NOT qualify
      makeEntry({ symbol: "LOW", shortInterestPct: 0.02 }),
      makeEntry({ symbol: "UNKNOWN", shortInterestPct: null }),
    ];
    const result = runFilterChain(
      baseInput({
        candidateSymbols: candidates,
        botSettings: {
          ...baseBotSettings,
          shortInterestSignal: ShortInterestSignal.TARGET_SHORT_SQUEEZE,
        },
      }),
    );
    expect(result.candidates.map((c) => c.symbol)).toEqual([
      "SQUEEZE_CANDIDATE",
    ]);
  });
});

describe("Full-chain integration — one per frame archetype", () => {
  it.each(Object.values(BotFrameName))(
    "%s frame: applies its configured market-cap/liquidity tiers",
    (frameName) => {
      const frame = FRAME_CONFIG[frameName];

      // Derive a value inside THIS frame's own first configured tier band —
      // frames don't share a common band (e.g. ANCHOR only accepts MEGA_CAP,
      // THRESHOLD only accepts LARGE_CAP/LIQUID_LARGE_CAPS, and those two
      // bands don't overlap), so a single hardcoded market cap can't pass every frame.
      const band = MARKET_CAP_TIER_USD_BANDS[frame.defaults.marketCapTiers[0]];
      const eligibleMarketCapUsd = band.max
        ? (band.min + band.max) / 2
        : band.min * 1.5;
      const eligibleAvgDollarVolume =
        LIQUIDITY_TIER_MIN_ADV_USD[frame.defaults.liquidityTier] * 1.5;

      const candidates = [
        makeEntry({
          symbol: "ELIGIBLE",
          marketCapUsd: eligibleMarketCapUsd,
          avgDollarVolume: eligibleAvgDollarVolume,
        }),
        makeEntry({
          symbol: "TOO_SMALL",
          marketCapUsd: 100_000_000, // below the platform's absolute $1B floor for every frame
        }),
      ];

      const result = runFilterChain(
        baseInput({
          candidateSymbols: candidates,
          frameMarketCapTiers: frame.defaults.marketCapTiers,
          frameLiquidityTier: frame.defaults.liquidityTier,
        }),
      );

      expect(result.candidates.map((c) => c.symbol)).toEqual(["ELIGIBLE"]);
    },
  );
});

describe("resolveRelevantParentSectors", () => {
  it("returns every parent sector when subSectors is empty", () => {
    expect(resolveRelevantParentSectors([])).toEqual(
      expect.arrayContaining(["Technology", "Energy", "Healthcare"]),
    );
  });

  it("resolves a Tier A label to its single parent sector", () => {
    expect(resolveRelevantParentSectors(["Software & SaaS"])).toEqual(["Technology"]);
  });

  it("resolves a Tier B label to its parent sector, same as Tier A", () => {
    expect(resolveRelevantParentSectors(["AI & Machine Learning"])).toEqual(["Technology"]);
  });

  it("deduplicates when multiple labels share a parent sector", () => {
    expect(
      resolveRelevantParentSectors(["Software & SaaS", "Semiconductors & Chips"]),
    ).toEqual(["Technology"]);
  });

  it("returns multiple parent sectors when labels span more than one", () => {
    expect(
      resolveRelevantParentSectors(["Software & SaaS", "Oil & Gas"]).sort(),
    ).toEqual(["Energy", "Technology"]);
  });
});

describe("runFilterChain output shape", () => {
  it("returns each surviving candidate's full marketDataSnapshot alongside its symbol", () => {
    const entry = makeEntry({ symbol: "AAPL" });
    const result = runFilterChain(baseInput({ candidateSymbols: [entry] }));
    expect(result.candidates).toEqual([
      { symbol: "AAPL", marketDataSnapshot: entry },
    ]);
  });
});
