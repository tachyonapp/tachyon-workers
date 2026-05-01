/**
 * Integration tests for callBrain() against a real local Postgres instance.
 * Requires: `docker compose up postgres` from tachyon-infra, with migration 007 applied.
 * The Anthropic SDK is mocked — no real API calls are made.
 *
 * Run in isolation: npm test -- --testPathPattern="integration"
 */

jest.mock("@anthropic-ai/sdk", () => {
  const create = jest.fn();
  const instance = { messages: { create } };
  const MockAnthropic = Object.assign(
    jest.fn(function () {
      return instance;
    }),
    { _instance: instance },
  );
  return { __esModule: true, default: MockAnthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { encrypt } from "../lib/crypto";
import { callBrain, getTradingDay } from "../lib/brain-router";

type MockedAnthropicModule = typeof Anthropic & {
  _instance: { messages: { create: jest.Mock } };
};

const mockCreate = (Anthropic as unknown as MockedAnthropicModule)._instance
  .messages.create;

const DAILY_CAP = 10;

let frameId: string;
let userId: string;
let botId: string;

const makeAnthropicMessage = (text: string) => ({
  content: [{ type: "text", text }],
});

beforeAll(async () => {
  const frame = await db
    .insertInto("bot_frames")
    .values({ name: `test-brain-router-${Date.now()}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  frameId = String(frame.id);

  const user = await db
    .insertInto("users")
    .values({
      auth0_subject: `test|brain-router-${Date.now()}`,
      display_name: "Brain Router Test User",
      email: `brain-router-${Date.now()}@test.com`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  userId = String(user.id);

  const bot = await db
    .insertInto("bots")
    .values({
      frame_id: frameId,
      user_id: userId,
      name: "Brain Router Test Bot",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  botId = String(bot.id);
});

afterEach(async () => {
  jest.clearAllMocks();
  // Clean up per-test rows — order matters for FK constraints
  await db.deleteFrom("brain_usage_log").where("bot_id", "=", botId).execute();
  await db.deleteFrom("bot_runtime_data").where("bot_id", "=", botId).execute();
  await db
    .deleteFrom("bot_brain_configs")
    .where("bot_id", "=", botId)
    .execute();
});

afterAll(async () => {
  // Deleting the bot cascades to brain_usage_log, bot_runtime_data, bot_brain_configs
  if (botId) await db.deleteFrom("bots").where("id", "=", botId).execute();
  if (userId) await db.deleteFrom("users").where("id", "=", userId).execute();
  if (frameId)
    await db.deleteFrom("bot_frames").where("id", "=", frameId).execute();
  await db.destroy();
});

describe("callBrain() integration", () => {
  it("TACHYON_HOSTED success: returns ok:true, writes brain_usage_log, increments ai_calls_today", async () => {
    const today = getTradingDay();

    await db
      .insertInto("bot_brain_configs")
      .values({
        bot_id: botId,
        brain_type: "TACHYON_HOSTED",
        model_id: "claude-haiku-4-5-20251001",
        provider: "anthropic",
      })
      .execute();

    await db
      .insertInto("bot_runtime_data")
      .values({
        bot_id: botId,
        trading_day: new Date(today),
        ai_calls_today: 0,
      })
      .execute();

    mockCreate.mockResolvedValueOnce(makeAnthropicMessage("Test explanation"));

    const result = await callBrain({
      botId,
      userId,
      prompt: "Explain this trade",
      dailyCap: DAILY_CAP,
    });

    expect(result).toMatchObject({ ok: true, content: "Test explanation" });

    const logRow = await db
      .selectFrom("brain_usage_log")
      .selectAll()
      .where("bot_id", "=", botId)
      .executeTakeFirst();

    expect(logRow).toBeDefined();
    expect(logRow?.success).toBe(true);
    expect(logRow?.cost_category).toBe("TACHYON_HOSTED");
    expect(String(logRow?.bot_id)).toBe(botId);
    expect(String(logRow?.user_id)).toBe(userId);

    const runtimeRow = await db
      .selectFrom("bot_runtime_data")
      .select("ai_calls_today")
      .where("bot_id", "=", botId)
      .where("trading_day", "=", new Date(today))
      .executeTakeFirst();

    expect(runtimeRow?.ai_calls_today).toBe(1);
  });

  it("BYOK Anthropic success: returns ok:true, writes brain_usage_log with BYOK, does NOT touch bot_runtime_data", async () => {
    const encryptedKey = encrypt("test-byok-api-key");

    await db
      .insertInto("bot_brain_configs")
      .values({
        bot_id: botId,
        brain_type: "BYOK",
        model_id: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        encrypted_key: encryptedKey,
      })
      .execute();

    mockCreate.mockResolvedValueOnce(makeAnthropicMessage("BYOK response"));

    const result = await callBrain({
      botId,
      userId,
      prompt: "Explain this trade",
      dailyCap: null,
    });

    expect(result).toMatchObject({ ok: true, content: "BYOK response" });

    const logRow = await db
      .selectFrom("brain_usage_log")
      .selectAll()
      .where("bot_id", "=", botId)
      .executeTakeFirst();

    expect(logRow).toBeDefined();
    expect(logRow?.success).toBe(true);
    expect(logRow?.cost_category).toBe("BYOK");

    const runtimeRow = await db
      .selectFrom("bot_runtime_data")
      .selectAll()
      .where("bot_id", "=", botId)
      .executeTakeFirst();

    expect(runtimeRow).toBeUndefined();
  });

  it("cap exceeded: returns CAP_EXCEEDED, no SDK call made, no brain_usage_log row, ai_calls_today unchanged", async () => {
    const today = getTradingDay();

    await db
      .insertInto("bot_brain_configs")
      .values({
        bot_id: botId,
        brain_type: "TACHYON_HOSTED",
        model_id: "claude-haiku-4-5-20251001",
        provider: "anthropic",
      })
      .execute();

    await db
      .insertInto("bot_runtime_data")
      .values({
        bot_id: botId,
        trading_day: new Date(today),
        ai_calls_today: DAILY_CAP,
      })
      .execute();

    const result = await callBrain({
      botId,
      userId,
      prompt: "Explain this trade",
      dailyCap: DAILY_CAP,
    });

    expect(result).toEqual({ ok: false, reason: "CAP_EXCEEDED" });
    expect(mockCreate).not.toHaveBeenCalled();

    const logRow = await db
      .selectFrom("brain_usage_log")
      .selectAll()
      .where("bot_id", "=", botId)
      .executeTakeFirst();

    expect(logRow).toBeUndefined();

    const runtimeRow = await db
      .selectFrom("bot_runtime_data")
      .select("ai_calls_today")
      .where("bot_id", "=", botId)
      .where("trading_day", "=", new Date(today))
      .executeTakeFirst();

    expect(runtimeRow?.ai_calls_today).toBe(DAILY_CAP);
  });
});
