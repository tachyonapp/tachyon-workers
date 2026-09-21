// EODHD Client
// =============================================================================
// PURPOSE
// =============================================================================
// Workers is the ONLY module in this codebase permitted to call EODHD (enforced
// by code review / module-boundary convention, not a runtime check). Wraps the
// EODHD Screener API (bulk sector/market-cap filtering) and Fundamentals Data
// Feed (dividend yield, short interest, earnings calendar). Deliberately
// tier-unaware — no branching on which EODHD plan is active (TDD Architecture &
// Integrations → Vendor License Tier & Environment Scoping).
//
// Pure network I/O only. No Valkey or Postgres access here — caching lives in
// universe-cache.ts, orchestration in universe-refresh.worker.ts.
//
// TODO:: NOTE ON WIRE FORMAT: EODHD's exact Screener/Fundamentals request shape (query
// params, batching limits, pagination) must still be confirmed against EODHD's live API
// docs at implementation time. The shapes below are a good-faith implementation against EODHD's
// publicly documented Screener/Fundamentals endpoints and MUST be verified
// against a real EODHD account before this goes live.
// =============================================================================
import { MarketCapTier } from "@tachyonapp/tachyon-queue-types";

const EODHD_API_BASE_URL = "https://eodhd.com/api"; // static vendor URL — no operational reason to make this env-tunable (see tachyon-infra DEV-5)

// US-only per platform constraint (long-only, stocks + ETFs only). EODHD
// requires an exchange suffix on every symbol (e.g. "AAPL.US").
const EODHD_EXCHANGE_SUFFIX = ".US";

// Non-overlapping numeric bands so a single symbol never lands in two
// market-cap-tier buckets. LIQUID_LARGE_CAPS intentionally shares LARGE_CAP's
// numeric band — it's a liquidity-driven tier, not a cap-driven one (see
// tachyon-queue-types DEV-3 ambiguity note; band pending Kevin/Brock confirmation).
const EODHD_MARKET_CAP_FILTERS: Record<
  MarketCapTier,
  { min: number; max?: number }
> = {
  [MarketCapTier.MEGA_CAP]: { min: 200_000_000_000 },
  [MarketCapTier.LARGE_CAP]: { min: 10_000_000_000, max: 200_000_000_000 },
  [MarketCapTier.LIQUID_LARGE_CAPS]: {
    min: 10_000_000_000,
    max: 200_000_000_000,
  },
  [MarketCapTier.MID_CAP]: { min: 2_000_000_000, max: 10_000_000_000 },
};

/**
 * Masks the `api_token` query param value before a URL is logged. Every log
 * call site in this file that includes a request URL MUST route it through
 * this helper first — EODHD's API key is sent as a query param, and Valkey/log
 * aggregators store this in plaintext (TDD Security → Touchpoints).
 */
export function maskApiKeyInUrl(url: string): string {
  return url.replace(/([?&]api_token=)[^&]+/i, "$1***REDACTED***");
}

export type EodhdErrorKind =
  | "rate_limit" // 429 / 402 — over plan quota or rate-limited
  | "client_error" // other 4xx — bad request, invalid symbol, etc.
  | "server_error" // 5xx — EODHD-side failure
  | "network_error"; // request never got a response (DNS, timeout, connection reset)

export class EodhdApiError extends Error {
  readonly kind: EodhdErrorKind;
  readonly status?: number;

  constructor(message: string, kind: EodhdErrorKind, status?: number) {
    super(message);
    this.name = "EodhdApiError";
    this.kind = kind;
    this.status = status;
  }
}

function classifyStatus(status: number): EodhdErrorKind {
  if (status === 429 || status === 402) return "rate_limit";
  if (status >= 500) return "server_error";
  return "client_error";
}

function toEodhdSymbol(symbol: string): string {
  return symbol.includes(".") ? symbol : `${symbol}${EODHD_EXCHANGE_SUFFIX}`;
}

function fromEodhdSymbol(eodhdSymbol: string): string {
  return eodhdSymbol.endsWith(EODHD_EXCHANGE_SUFFIX)
    ? eodhdSymbol.slice(0, -EODHD_EXCHANGE_SUFFIX.length)
    : eodhdSymbol;
}

function requireApiKey(): string {
  const apiKey = process.env.EODHD_API_KEY;
  if (!apiKey) {
    throw new EodhdApiError("EODHD_API_KEY is not set", "client_error");
  }
  return apiKey;
}

/** Performs the fetch, masking the API key in any logged URL, and classifies failures. */
async function eodhdFetch(url: string, event: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event,
        errorKind: "network_error",
        url: maskApiKeyInUrl(url),
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw new EodhdApiError(
      `EODHD request failed: ${err instanceof Error ? err.message : String(err)}`,
      "network_error",
    );
  }

  if (!response.ok) {
    const kind = classifyStatus(response.status);
    console.error(
      JSON.stringify({
        level: "error",
        event,
        errorKind: kind,
        status: response.status,
        url: maskApiKeyInUrl(url),
      }),
    );
    throw new EodhdApiError(
      `EODHD request failed with status ${response.status}`,
      kind,
      response.status,
    );
  }

  return response.json();
}

export interface ScreenerBucketQuery {
  parentSector: string; // GICS sector filter value sent to EODHD
  marketCapTier: MarketCapTier; // translated to EODHD's numeric min/max cap filter
}

export interface ScreenerResult {
  symbol: string;
  gicsSubIndustry: string; // raw EODHD classification string — translated by caller via GICS_SUB_SECTOR_MAP
  marketCapUsd: number;
  avgDollarVolume: number;
  price: number;
}

interface EodhdScreenerRow {
  code: string;
  gic_sub_industry?: string;
  market_capitalization?: number;
  avgvol_1d?: number;
  adjusted_close?: number;
}

/**
 * Fetches one (parent-sector × market-cap-tier) bucket from EODHD's Screener API.
 */
export async function fetchScreenerBucket(
  query: ScreenerBucketQuery,
): Promise<ScreenerResult[]> {
  const apiKey = requireApiKey();
  const capFilter = EODHD_MARKET_CAP_FILTERS[query.marketCapTier];

  const filters: unknown[] = [
    ["sector", "=", query.parentSector],
    ["market_capitalization", ">=", capFilter.min],
  ];
  if (capFilter.max !== undefined) {
    filters.push(["market_capitalization", "<", capFilter.max]);
  }

  const url =
    `${EODHD_API_BASE_URL}/screener` +
    `?api_token=${apiKey}` +
    `&filters=${encodeURIComponent(JSON.stringify(filters))}` +
    `&limit=500` +
    `&fmt=json`;

  const body = (await eodhdFetch(url, "eodhd.screener.request_failed")) as {
    data?: EodhdScreenerRow[];
  };

  return (body.data ?? []).map((row) => ({
    symbol: fromEodhdSymbol(row.code),
    gicsSubIndustry: row.gic_sub_industry ?? "",
    marketCapUsd: row.market_capitalization ?? 0,
    avgDollarVolume: (row.avgvol_1d ?? 0) * (row.adjusted_close ?? 0),
    price: row.adjusted_close ?? 0,
  }));
}

export interface FundamentalsResult {
  symbol: string;
  dividendYield: number | null;
  shortInterestPct: number | null; // from EODHD ShareStats — lower fidelity accepted per TDD
  nextEarningsDate: string | null; // ISO date
}

interface EodhdFundamentalsResponse {
  Highlights?: { DividendYield?: number | null };
  SharesStats?: { ShortPercentFloat?: number | null };
  Earnings?: { Upcoming?: { data?: { date?: string }[] } };
}

/**
 * Fetches fundamentals (dividend yield, short interest, next earnings date) for
 * each symbol. EODHD's Fundamentals endpoint is per-symbol, not bulk — this
 * issues one request per symbol. A single symbol's failure does not abort the
 * rest; it's omitted from the result (caller/DEV-8 treats a short result array
 * as a partial-success bucket, same as any other per-bucket EODHD failure).
 */
export async function fetchFundamentals(
  symbols: string[],
): Promise<FundamentalsResult[]> {
  const apiKey = requireApiKey();

  const results = await Promise.all(
    symbols.map(async (symbol): Promise<FundamentalsResult | null> => {
      const eodhdSymbol = toEodhdSymbol(symbol);
      const url = `${EODHD_API_BASE_URL}/fundamentals/${eodhdSymbol}?api_token=${apiKey}&fmt=json`;

      try {
        const body = (await eodhdFetch(
          url,
          "eodhd.fundamentals.request_failed",
        )) as EodhdFundamentalsResponse;

        return {
          symbol,
          dividendYield: body.Highlights?.DividendYield ?? null,
          shortInterestPct: body.SharesStats?.ShortPercentFloat ?? null,
          nextEarningsDate: body.Earnings?.Upcoming?.data?.[0]?.date ?? null,
        };
      } catch (err) {
        // Only an isolated bad symbol (e.g. a delisted ticker, 404) is skipped.
        // rate_limit/server_error/network_error are systemic — rethrow so the
        // whole bucket fetch fails and DEV-8's breaker counter sees it, rather
        // than silently returning a partial/empty result during an outage.
        if (err instanceof EodhdApiError && err.kind !== "client_error") {
          throw err;
        }
        console.error(
          JSON.stringify({
            level: "error",
            event: "eodhd.fundamentals.symbol_skipped",
            symbol,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return null;
      }
    }),
  );

  return results.filter((r): r is FundamentalsResult => r !== null);
}
