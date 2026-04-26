import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { db } from "../db";

export interface BrainCallInput {
  botId: string;
  userId: string;
  prompt: string;
  maxTokens?: number; // default: 512
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
  _input: BrainCallInput,
): Promise<BrainCallResult> {
  console.log(_input);
  throw new Error("not implemented — complete in brain-router Ticket B");
}

// --- Pure Helpers (exported for unit testing) ---

export function getTradingDay(): string {
  return DateTime.now().setZone("America/New_York").toISODate()!;
}

export function classifyProviderError(err: unknown): string {
  if (err instanceof Anthropic.APIError)
    return `anthropic_${err.status ?? "unknown"}`;
  // if (err instanceof OpenAI.APIError) return `openai_${err.status ?? 'unknown'}`;
  if (err instanceof Error && err.message.includes("timeout")) return "timeout";
  return "unknown";
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

export async function writeUsageLog(p: UsageLogParams): Promise<void> {
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
