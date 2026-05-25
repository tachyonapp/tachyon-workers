import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DateTime } from "luxon";
import { sql } from "kysely";
import { db } from "../db";
import { decrypt } from "./crypto";

// Module-level client for Tachyon-hosted calls only.
// BYOK SDK instances are created per-call and must NOT be module-level.
const tachyonAnthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 15_000,
});

// Variant → canonical model ID maps.
// IMPORTANT: tachyon-api/src/config/brainProviders.ts contains the authoritative copy.
// When model IDs change in brainProviders.ts, update this file too.
// Follow-on tech debt: move to @tachyonapp/tachyon-queue-types/config.
const ANTHROPIC_VARIANT_MODEL_IDS: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus:   "claude-opus-4-7",
  // haiku is reserved for TACHYON_HOSTED — not stored as a BYOK variant
};

const OPENAI_VARIANT_MODEL_IDS: Record<string, string> = {
  "gpt-4o":      "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini",
};

const GROQ_VARIANT_MODEL_IDS: Record<string, string> = {
  "llama-4-scout":    "llama-4-scout-17b-16e-instruct",
  "llama-4-maverick": "llama-4-maverick-17b-128e-instruct",
  "llama-3.3-70b":    "llama-3.3-70b-versatile",
};

const GEMINI_VARIANT_MODEL_IDS: Record<string, string> = {
  "gemini-2.0-flash": "gemini-2.0-flash",
  "gemini-2.5-flash": "gemini-2.5-flash-preview-05-20",
};

// Groq and Gemini use OpenAI-compatible endpoints; dispatch via openai SDK with baseURL override.
// IMPORTANT: keep in sync with tachyon-api/src/config/brainProviders.ts.
const BYOK_PROVIDER_BASE_URLS: Partial<Record<string, string>> = {
  groq:   "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
};

// --- Public Interface ---

export interface BrainCallInput {
  botId: string;
  userId: string;
  prompt: string;
  maxTokens?: number; // default: 512
  dailyCap: number | null; // null = no cap (BYOK); number = enforce cap against ai_calls_today
}

export type BrainCallResult =
  | {
      ok: true;
      content: string;
      provider: string;
      modelId: string;
      latencyMs: number;
    }
  | {
      ok: false;
      reason:
        | "CAP_EXCEEDED"
        | "NO_BRAIN_CONFIG"
        | "PROVIDER_ERROR"
        | "DECRYPTION_ERROR";
      detail?: string;
    };

export async function callBrain(
  input: BrainCallInput,
): Promise<BrainCallResult> {
  const { botId, userId, prompt, maxTokens = 512, dailyCap } = input;

  // 1. Fetch active brain config
  const brainConfig = await db
    .selectFrom("bot_brain_configs")
    .select([
      "brain_type",
      "model_id",
      "provider",
      "encrypted_key",
      "openai_model_variant",
      "anthropic_model_variant",
      "groq_model_variant",
      "gemini_model_variant",
    ] as const)
    .where("bot_id", "=", botId)
    .where("is_active", "=", true)
    .executeTakeFirst();

  if (!brainConfig) {
    return { ok: false, reason: "NO_BRAIN_CONFIG" };
  }

  const today = getTradingDay();

  // 2. Cap check — read-then-gate (not atomic; max overrun = concurrency-1)
  if (dailyCap !== null) {
    const runtimeRow = await db
      .selectFrom("bot_runtime_data")
      .select("ai_calls_today")
      .where("bot_id", "=", botId)
      .where("trading_day", "=", new Date(today))
      .executeTakeFirst();

    const callsToday = runtimeRow?.ai_calls_today ?? 0;
    if (callsToday >= dailyCap) {
      return { ok: false, reason: "CAP_EXCEEDED" };
    }
  }

  // 3. Dispatch to provider
  const startMs = Date.now();
  let content: string;
  let resolvedModelId: string | undefined;

  try {
    if (brainConfig.brain_type === "TACHYON_HOSTED") {
      resolvedModelId = brainConfig.model_id;
      content = await callAnthropic(
        tachyonAnthropic,
        brainConfig.model_id,
        prompt,
        maxTokens,
      );
    } else {
      // BYOK — resolve effective model ID from variant column (with null fallback to model_id)
      let effectiveModelId: string;
      const provider = brainConfig.provider;

      if (provider === "anthropic") {
        const variant = brainConfig.anthropic_model_variant;
        if (variant !== null && variant !== undefined) {
          const resolved = ANTHROPIC_VARIANT_MODEL_IDS[variant];
          if (!resolved) {
            console.error(JSON.stringify({
              level: "error", event: "brain.variant.unknown",
              botId, variant, provider: "anthropic",
              errorCode: "SCAN_BOT_BRAIN_CONFIG_INVALID",
            }));
            return { ok: false, reason: "PROVIDER_ERROR", detail: "SCAN_BOT_BRAIN_CONFIG_INVALID" };
          }
          effectiveModelId = resolved;
        } else {
          effectiveModelId = brainConfig.model_id; // null fallback — backward compat
        }
      } else if (provider === "openai") {
        const variant = brainConfig.openai_model_variant;
        if (variant !== null && variant !== undefined) {
          const resolved = OPENAI_VARIANT_MODEL_IDS[variant];
          if (!resolved) {
            console.error(JSON.stringify({
              level: "error", event: "brain.variant.unknown",
              botId, variant, provider: "openai",
              errorCode: "SCAN_BOT_BRAIN_CONFIG_INVALID",
            }));
            return { ok: false, reason: "PROVIDER_ERROR", detail: "SCAN_BOT_BRAIN_CONFIG_INVALID" };
          }
          effectiveModelId = resolved;
        } else {
          effectiveModelId = brainConfig.model_id; // null fallback — backward compat
        }
      } else if (provider === "groq") {
        const variant = brainConfig.groq_model_variant;
        if (variant !== null && variant !== undefined) {
          const resolved = GROQ_VARIANT_MODEL_IDS[variant];
          if (!resolved) {
            console.error(JSON.stringify({
              level: "error", event: "brain.variant.unknown",
              botId, variant, provider: "groq",
              errorCode: "SCAN_BOT_BRAIN_CONFIG_INVALID",
            }));
            return { ok: false, reason: "PROVIDER_ERROR", detail: "SCAN_BOT_BRAIN_CONFIG_INVALID" };
          }
          effectiveModelId = resolved;
        } else {
          effectiveModelId = brainConfig.model_id; // null fallback — backward compat
        }
      } else if (provider === "gemini") {
        const variant = brainConfig.gemini_model_variant;
        if (variant !== null && variant !== undefined) {
          const resolved = GEMINI_VARIANT_MODEL_IDS[variant];
          if (!resolved) {
            console.error(JSON.stringify({
              level: "error", event: "brain.variant.unknown",
              botId, variant, provider: "gemini",
              errorCode: "SCAN_BOT_BRAIN_CONFIG_INVALID",
            }));
            return { ok: false, reason: "PROVIDER_ERROR", detail: "SCAN_BOT_BRAIN_CONFIG_INVALID" };
          }
          effectiveModelId = resolved;
        } else {
          effectiveModelId = brainConfig.model_id; // null fallback — backward compat
        }
      } else {
        return { ok: false, reason: "PROVIDER_ERROR", detail: `Unsupported provider: ${provider}` };
      }

      let rawKey: string;
      try {
        rawKey = decrypt(brainConfig.encrypted_key!);
      } catch (err) {
        return { ok: false, reason: "DECRYPTION_ERROR", detail: String(err) };
      }

      if (provider === "anthropic") {
        const byokClient = new Anthropic({ apiKey: rawKey, timeout: 15_000 });
        content = await callAnthropic(byokClient, effectiveModelId, prompt, maxTokens);
      } else if (provider === "openai") {
        const byokClient = new OpenAI({ apiKey: rawKey, timeout: 15_000 });
        content = await callOpenAI(byokClient, effectiveModelId, prompt, maxTokens);
      } else if (provider === "groq") {
        // Groq — OpenAI-compatible endpoint; reuse openai SDK with baseURL override
        const byokClient = new OpenAI({ apiKey: rawKey, baseURL: BYOK_PROVIDER_BASE_URLS.groq, timeout: 15_000 });
        content = await callOpenAI(byokClient, effectiveModelId, prompt, maxTokens);
      } else if (provider === "gemini") {
        // Gemini — OpenAI-compatible endpoint; reuse openai SDK with baseURL override
        const byokClient = new OpenAI({ apiKey: rawKey, baseURL: BYOK_PROVIDER_BASE_URLS.gemini, timeout: 15_000 });
        content = await callOpenAI(byokClient, effectiveModelId, prompt, maxTokens);
      } else {
        return { ok: false, reason: "PROVIDER_ERROR", detail: `Unsupported provider: ${provider}` };
      }

      // Assign effectiveModelId to outer scope for usage log
      resolvedModelId = effectiveModelId;
    }
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const errorCode = classifyProviderError(err);

    try {
      await writeUsageLog({
        botId,
        userId,
        today,
        provider: brainConfig.provider ?? "anthropic",
        modelId: resolvedModelId ?? brainConfig.model_id,
        costCategory: brainConfig.brain_type,
        latencyMs,
        success: false,
        errorCode,
      });
    } catch (logErr) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "brain.usage_log.write_failed",
          error: String(logErr),
        }),
      );
    }

    return { ok: false, reason: "PROVIDER_ERROR", detail: errorCode };
  }

  const latencyMs = Date.now() - startMs;

  // 4. Post-success: increment counter when cap applies
  if (dailyCap !== null) {
    try {
      await db
        .insertInto("bot_runtime_data")
        .values({
          bot_id: botId,
          trading_day: new Date(today),
          ai_calls_today: 1,
        })
        .onConflict((oc) =>
          oc.columns(["bot_id", "trading_day"]).doUpdateSet({
            ai_calls_today: sql<number>`bot_runtime_data.ai_calls_today + 1`,
            updated_at: new Date(),
          }),
        )
        .execute();
    } catch (err) {
      // Log but do not discard the successful AI response
      console.error(
        JSON.stringify({
          level: "error",
          event: "brain.counter.increment_failed",
          botId,
          error: String(err),
        }),
      );
    }
  }

  // 5. Write usage log (success path)
  try {
    await writeUsageLog({
      botId,
      userId,
      today,
      provider: brainConfig.provider ?? "anthropic",
      modelId: resolvedModelId ?? brainConfig.model_id,
      costCategory: brainConfig.brain_type,
      latencyMs,
      success: true,
      errorCode: undefined,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "brain.usage_log.write_failed",
        error: String(err),
      }),
    );
  }

  return {
    ok: true,
    content,
    provider: brainConfig.provider ?? "anthropic",
    modelId: resolvedModelId ?? brainConfig.model_id,
    latencyMs,
  };
}

// --- Pure Helpers (exported for unit testing) ---

export function getTradingDay(): string {
  return DateTime.now().setZone("America/New_York").toISODate()!;
}

export function classifyProviderError(err: unknown): string {
  if (err instanceof Anthropic.APIError)
    return `anthropic_${err.status ?? "unknown"}`;
  if (
    err instanceof Error &&
    (err.message.includes("timeout") || err.message.includes("timed out"))
  )
    return "timeout";
  return "unknown";
}

// --- Private Provider Dispatchers ---

async function callAnthropic(
  client: Anthropic,
  modelId: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const message = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const block = message.content[0];
  if (block?.type !== "text")
    throw new Error("Anthropic returned non-text content block");
  return block.text;
}

export async function callOpenAI(
  client: OpenAI,
  modelId: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const completion = await client.chat.completions.create({
    model: modelId,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("OpenAI-compatible provider returned empty content");
  return text;
}

// --- DB Helper ---

interface UsageLogParams {
  botId: string;
  userId: string;
  today: string;
  provider: string;
  modelId: string;
  costCategory: string;
  latencyMs: number;
  success: boolean;
  errorCode: string | undefined;
}

async function writeUsageLog(p: UsageLogParams): Promise<void> {
  await db
    .insertInto("brain_usage_log")
    .values({
      bot_id: p.botId,
      user_id: p.userId,
      trading_day: p.today,
      provider: p.provider,
      model_id: p.modelId,
      cost_category: p.costCategory,
      latency_ms: p.latencyMs,
      success: p.success,
      error_code: p.errorCode ?? null,
    })
    .execute();
}
