import { Settings } from "luxon";
import Anthropic from "@anthropic-ai/sdk";
import { decrypt } from "../crypto";
import { getTradingDay, classifyProviderError, callBrain } from "../brain-router";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.DB_ENCRYPTION_KEY = "a".repeat(64);

// --- Mocks ---
// All mock functions are created inside factories (ts-jest hoists jest.mock before const declarations).
// Expose internals via _test / _instance so tests can access them after import.

jest.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status: number | undefined, message: string) {
      super(message);
      this.name = "APIError";
      this.status = status;
    }
  }
  const create = jest.fn();
  const instance = { messages: { create } };
  const MockAnthropic = Object.assign(
    jest.fn(function () { return instance; }),
    { APIError, _instance: instance },
  );
  return { __esModule: true, default: MockAnthropic };
});

jest.mock("../../db", () => {
  const executeTakeFirst = jest.fn();
  const execute = jest.fn().mockResolvedValue([]);
  const onConflict = jest.fn().mockReturnValue({ execute });
  const selectBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    executeTakeFirst,
  };
  const insertBuilder = {
    values: jest.fn().mockReturnThis(),
    onConflict,
    execute,
  };
  const selectFrom = jest.fn().mockReturnValue(selectBuilder);
  const insertInto = jest.fn().mockReturnValue(insertBuilder);
  return {
    db: { selectFrom, insertInto },
    _test: { executeTakeFirst, execute, onConflict, selectFrom, insertInto },
  };
});

jest.mock("../crypto", () => ({
  decrypt: jest.fn(),
  encrypt: jest.fn(),
}));

// Typed accessors for mock internals — avoids casting to any
type MockedAnthropicModule = typeof Anthropic & {
  _instance: { messages: { create: jest.Mock } };
};
type TwoArgAPIErrorCtor = new (status: number, message: string) => InstanceType<typeof Anthropic.APIError>;

// Get references to mock internals after mocks are in place
const mockCreate = (Anthropic as unknown as MockedAnthropicModule)._instance.messages.create;
const mockDecrypt = decrypt as jest.Mock;
const { _test } = jest.requireMock("../../db");
const mockExecuteTakeFirst = _test.executeTakeFirst as jest.Mock;
const mockOnConflict = _test.onConflict as jest.Mock;
const mockInsertInto = _test.insertInto as jest.Mock;

// --- Fixtures ---

const makeTachyonConfig = () => ({
  brain_type: "TACHYON_HOSTED",
  model_id: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  encrypted_key: null,
});

const makeByokConfig = () => ({
  brain_type: "BYOK",
  model_id: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  encrypted_key: "iv:cipher:tag",
});

const makeAnthropicMessage = (text: string) => ({
  content: [{ type: "text", text }],
});

const baseInput = { botId: "1", userId: "2", prompt: "Explain this trade", dailyCap: 10 };
const byokInput = { botId: "1", userId: "2", prompt: "Explain this trade", dailyCap: null };

// --- Tests ---

describe("getTradingDay()", () => {
  afterEach(() => {
    Settings.now = () => Date.now();
  });

  it("returns a YYYY-MM-DD formatted string", () => {
    expect(getTradingDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns the New York date, not UTC (03:00 UTC = 22:00 ET previous day)", () => {
    const utcJan16At03 = new Date("2025-01-16T03:00:00Z").getTime();
    Settings.now = () => utcJan16At03;
    expect(getTradingDay()).toBe("2025-01-15");
  });
});

describe("classifyProviderError()", () => {
  it('returns "anthropic_429" for Anthropic 429 error', () => {
    const MockAPIError = Anthropic.APIError as unknown as TwoArgAPIErrorCtor;
    const err = new MockAPIError(429, "rate limited");
    expect(classifyProviderError(err)).toBe("anthropic_429");
  });

  it('returns "anthropic_500" for Anthropic 500 error', () => {
    const MockAPIError = Anthropic.APIError as unknown as TwoArgAPIErrorCtor;
    const err = new MockAPIError(500, "server error");
    expect(classifyProviderError(err)).toBe("anthropic_500");
  });

  it('returns "timeout" for Error with "timeout" in message', () => {
    expect(classifyProviderError(new Error("Request timed out"))).toBe("timeout");
  });

  it('returns "unknown" for a generic Error', () => {
    expect(classifyProviderError(new Error("network error"))).toBe("unknown");
  });

  it('returns "unknown" for a non-Error value', () => {
    expect(classifyProviderError("just a string")).toBe("unknown");
  });
});

describe("callBrain()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns NO_BRAIN_CONFIG when no active brain config exists", async () => {
    mockExecuteTakeFirst.mockResolvedValueOnce(undefined);

    const result = await callBrain(baseInput);

    expect(result).toEqual({ ok: false, reason: "NO_BRAIN_CONFIG" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns CAP_EXCEEDED when ai_calls_today >= DAILY_CAP, no SDK call made", async () => {
    mockExecuteTakeFirst
      .mockResolvedValueOnce(makeTachyonConfig())
      .mockResolvedValueOnce({ ai_calls_today: 10 }); // equals cap

    const result = await callBrain(baseInput);

    expect(result).toEqual({ ok: false, reason: "CAP_EXCEEDED" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("TACHYON_HOSTED: calls tachyonAnthropic and returns ok:true with correct fields", async () => {
    mockExecuteTakeFirst
      .mockResolvedValueOnce(makeTachyonConfig())
      .mockResolvedValueOnce({ ai_calls_today: 0 });
    mockCreate.mockResolvedValueOnce(makeAnthropicMessage("Test explanation"));

    const result = await callBrain(baseInput);

    expect(result).toMatchObject({
      ok: true,
      content: "Test explanation",
      provider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "Explain this trade" }],
      }),
    );
  });

  it("TACHYON_HOSTED success: upserts bot_runtime_data with ai_calls_today", async () => {
    mockExecuteTakeFirst
      .mockResolvedValueOnce(makeTachyonConfig())
      .mockResolvedValueOnce({ ai_calls_today: 0 });
    mockCreate.mockResolvedValueOnce(makeAnthropicMessage("ok"));

    await callBrain(baseInput);

    const insertedTables = mockInsertInto.mock.calls.map(([t]: [string]) => t);
    expect(insertedTables).toContain("bot_runtime_data");
    expect(mockOnConflict).toHaveBeenCalled();
  });

  it("BYOK anthropic: decrypts key and returns ok:true", async () => {
    mockExecuteTakeFirst.mockResolvedValueOnce(makeByokConfig());
    mockDecrypt.mockReturnValueOnce("raw-api-key");
    mockCreate.mockResolvedValueOnce(makeAnthropicMessage("BYOK response"));

    const result = await callBrain(byokInput);

    expect(mockDecrypt).toHaveBeenCalledWith("iv:cipher:tag");
    expect(result).toMatchObject({ ok: true, content: "BYOK response" });
  });

  it("BYOK success: does NOT upsert bot_runtime_data", async () => {
    mockExecuteTakeFirst.mockResolvedValueOnce(makeByokConfig());
    mockDecrypt.mockReturnValueOnce("raw-api-key");
    mockCreate.mockResolvedValueOnce(makeAnthropicMessage("ok"));

    await callBrain(byokInput);

    const insertedTables = mockInsertInto.mock.calls.map(([t]: [string]) => t);
    expect(insertedTables).not.toContain("bot_runtime_data");
  });

  it("returns DECRYPTION_ERROR when decrypt throws, no brain_usage_log written", async () => {
    mockExecuteTakeFirst.mockResolvedValueOnce(makeByokConfig());
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error("bad key material");
    });

    const result = await callBrain(byokInput);

    expect(result).toEqual({
      ok: false,
      reason: "DECRYPTION_ERROR",
      detail: expect.stringContaining("bad key material"),
    });
    expect(mockInsertInto).not.toHaveBeenCalled();
  });

  it("returns PROVIDER_ERROR and writes failure row to brain_usage_log when SDK throws", async () => {
    mockExecuteTakeFirst
      .mockResolvedValueOnce(makeTachyonConfig())
      .mockResolvedValueOnce({ ai_calls_today: 0 });
    mockCreate.mockRejectedValueOnce(new Error("connection refused"));

    const result = await callBrain(baseInput);

    expect(result).toEqual({ ok: false, reason: "PROVIDER_ERROR", detail: "unknown" });
    const insertedTables = mockInsertInto.mock.calls.map(([t]: [string]) => t);
    expect(insertedTables).toContain("brain_usage_log");
  });
});
