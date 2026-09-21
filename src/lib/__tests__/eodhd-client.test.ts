import { MarketCapTier } from "@tachyonapp/tachyon-queue-types";
import {
  fetchScreenerBucket,
  fetchFundamentals,
  maskApiKeyInUrl,
  EodhdApiError,
} from "../eodhd-client";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe("maskApiKeyInUrl", () => {
  it("redacts the api_token query param value", () => {
    const url =
      "https://eodhd.com/api/screener?api_token=SUPER_SECRET&limit=500";
    expect(maskApiKeyInUrl(url)).toBe(
      "https://eodhd.com/api/screener?api_token=***REDACTED***&limit=500",
    );
  });

  it("redacts when api_token is not the first query param", () => {
    const url =
      "https://eodhd.com/api/fundamentals/AAPL.US?fmt=json&api_token=SUPER_SECRET";
    expect(maskApiKeyInUrl(url)).toBe(
      "https://eodhd.com/api/fundamentals/AAPL.US?fmt=json&api_token=***REDACTED***",
    );
  });

  it("leaves a URL with no api_token untouched", () => {
    const url = "https://eodhd.com/api/screener?limit=500";
    expect(maskApiKeyInUrl(url)).toBe(url);
  });
});

describe("fetchScreenerBucket", () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("fetches and maps a successful screener response", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            code: "AAPL.US",
            gic_sub_industry: "Technology Hardware, Storage & Peripherals",
            market_capitalization: 3_000_000_000_000,
            avgvol_1d: 50_000_000,
            adjusted_close: 190,
          },
        ],
      }),
    );

    const result = await fetchScreenerBucket({
      parentSector: "Technology",
      marketCapTier: MarketCapTier.MEGA_CAP,
    });

    expect(result).toEqual([
      {
        symbol: "AAPL",
        gicsSubIndustry: "Technology Hardware, Storage & Peripherals",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 50_000_000 * 190,
        price: 190,
      },
    ]);

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`${"https://eodhd.com/api"}/screener`);
    expect(calledUrl).toContain("api_token=test-key");
  });

  it("returns an empty array when the screener response has no data", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    const result = await fetchScreenerBucket({
      parentSector: "Energy",
      marketCapTier: MarketCapTier.MID_CAP,
    });
    expect(result).toEqual([]);
  });

  it("classifies a 429 response as rate_limit and throws EodhdApiError", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, false, 429));

    await expect(
      fetchScreenerBucket({
        parentSector: "Technology",
        marketCapTier: MarketCapTier.MEGA_CAP,
      }),
    ).rejects.toMatchObject({ kind: "rate_limit", status: 429 });
  });

  it("classifies a 500 response as server_error", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, false, 500));

    await expect(
      fetchScreenerBucket({
        parentSector: "Technology",
        marketCapTier: MarketCapTier.MEGA_CAP,
      }),
    ).rejects.toMatchObject({ kind: "server_error", status: 500 });
  });

  it("classifies a rejected fetch (network failure) as network_error", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      fetchScreenerBucket({
        parentSector: "Technology",
        marketCapTier: MarketCapTier.MEGA_CAP,
      }),
    ).rejects.toMatchObject({ kind: "network_error" });
  });

  it("never logs an unmasked API key on failure", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, false, 500));

    await expect(
      fetchScreenerBucket({
        parentSector: "Technology",
        marketCapTier: MarketCapTier.MEGA_CAP,
      }),
    ).rejects.toThrow(EodhdApiError);

    const loggedOutput = errorSpy.mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    expect(loggedOutput).not.toContain("test-key");
    expect(loggedOutput).toContain("***REDACTED***");

    errorSpy.mockRestore();
  });
});

describe("fetchFundamentals", () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("fetches and maps fundamentals for multiple symbols", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          Highlights: { DividendYield: 0.005 },
          SharesStats: { ShortPercentFloat: 0.012 },
          Earnings: { Upcoming: { data: [{ date: "2026-10-30" }] } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Highlights: {},
          SharesStats: {},
          Earnings: { Upcoming: { data: [] } },
        }),
      );

    const result = await fetchFundamentals(["AAPL", "MSFT"]);

    expect(result).toEqual([
      {
        symbol: "AAPL",
        dividendYield: 0.005,
        shortInterestPct: 0.012,
        nextEarningsDate: "2026-10-30",
      },
      {
        symbol: "MSFT",
        dividendYield: null,
        shortInterestPct: null,
        nextEarningsDate: null,
      },
    ]);
  });

  it("skips an isolated bad symbol (client_error) without failing the whole call", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({}, false, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          Highlights: { DividendYield: 0.01 },
          SharesStats: {},
          Earnings: { Upcoming: { data: [] } },
        }),
      );

    const result = await fetchFundamentals(["DELISTED", "MSFT"]);

    expect(result).toEqual([
      {
        symbol: "MSFT",
        dividendYield: 0.01,
        shortInterestPct: null,
        nextEarningsDate: null,
      },
    ]);
  });

  it("propagates a systemic failure (rate_limit) instead of returning a partial result", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, false, 429));

    await expect(fetchFundamentals(["AAPL", "MSFT"])).rejects.toMatchObject({
      kind: "rate_limit",
    });
  });
});
