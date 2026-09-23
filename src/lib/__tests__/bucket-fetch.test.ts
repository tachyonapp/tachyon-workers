jest.mock("../eodhd-client", () => ({
  fetchScreenerBucket: jest.fn(),
  fetchFundamentals: jest.fn(),
}));

import { MarketCapTier } from "@tachyonapp/tachyon-queue-types";
import { fetchBucketSymbols } from "../bucket-fetch";
import * as eodhdClient from "../eodhd-client";

const mockedFetchScreenerBucket = eodhdClient.fetchScreenerBucket as jest.Mock;
const mockedFetchFundamentals = eodhdClient.fetchFundamentals as jest.Mock;

describe("fetchBucketSymbols", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches, joins fundamentals, translates the GICS label, and tags parentSector", async () => {
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

    const result = await fetchBucketSymbols("Technology", MarketCapTier.MEGA_CAP);

    expect(mockedFetchScreenerBucket).toHaveBeenCalledWith({
      parentSector: "Technology",
      marketCapTier: MarketCapTier.MEGA_CAP,
    });
    expect(mockedFetchFundamentals).toHaveBeenCalledWith(["AAPL"]);
    expect(result).toEqual([
      {
        symbol: "AAPL",
        parentSector: "Technology",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        resolvedSubSectors: ["Consumer Electronics"],
        dividendYield: 0.005,
        shortInterestPct: 0.01,
        nextEarningsDate: "2026-10-30",
        price: 190,
      },
    ]);
  });

  it("resolves to an empty resolvedSubSectors array when the GICS sub-industry has no map entry", async () => {
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

    const result = await fetchBucketSymbols("Energy", MarketCapTier.MID_CAP);

    expect(result[0].resolvedSubSectors).toEqual([]);
  });

  it("defaults fundamentals fields to null when a symbol has no fundamentals match", async () => {
    mockedFetchScreenerBucket.mockResolvedValue([
      {
        symbol: "AAPL",
        gicsSubIndustry: "Consumer Electronics",
        marketCapUsd: 3_000_000_000_000,
        avgDollarVolume: 9_000_000_000,
        price: 190,
      },
    ]);
    mockedFetchFundamentals.mockResolvedValue([]); // no match for AAPL

    const result = await fetchBucketSymbols("Technology", MarketCapTier.MEGA_CAP);

    expect(result[0].dividendYield).toBeNull();
    expect(result[0].shortInterestPct).toBeNull();
    expect(result[0].nextEarningsDate).toBeNull();
  });

  it("propagates a screener fetch failure", async () => {
    mockedFetchScreenerBucket.mockRejectedValue(new Error("EODHD unreachable"));

    await expect(
      fetchBucketSymbols("Technology", MarketCapTier.MEGA_CAP),
    ).rejects.toThrow("EODHD unreachable");
  });
});
