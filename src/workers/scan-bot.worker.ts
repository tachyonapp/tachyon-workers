/**
 * Per-Agent Scan Worker
 *
 * Role: "Individual agent scanner" — processes one scan-bot job per agent.
 * Jobs are enqueued in bulk by scan-dispatch.worker.ts each cron tick.
 * This worker does NOT run market-hours check itself; scan-dispatch already
 * guards the entire fan-out and would not have enqueued these jobs if the
 * market were closed.
 *
 * Ownership re-validation:
 * There is a deliberate time gap between when scan-dispatch queries ACTIVE bots
 * and when this processor runs. In that window, a bot could be paused, archived,
 * or its owner could have revoked their broker connection. We re-validate here
 * to avoid acting on stale state. This is a "check-then-act" guard, not
 * authoritative enforcement — the rule engine enforces hard limits.
 *
 * Concurrency: BULLMQ_CONCURRENCY (default 5) — multiple scan-bot jobs can
 * run in parallel within a single worker process. Each job is isolated to its
 * own agent, so there is no shared state between concurrent executions.
 *
 * This file never imports eodhd-client.ts. The
 * staleness gate's bounded refresh goes through bucket-fetch.ts, the same
 * shared module universe-refresh.worker.ts uses — eodhd-client.ts is never
 * imported from more than that one place.
 */

import { Worker, type Job } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  MarketCapTier,
  DividendPreference,
  ShortInterestSignal,
  EarningsBehavior,
  FRAME_CONFIG,
  type BotFrameName,
  type ScanBotJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { db } from "../db";
import { evaluateStalenessGate } from "../lib/staleness-gate";
import {
  runFilterChain,
  resolveRelevantParentSectors,
} from "../lib/universe-filter-chain";
import {
  isWithinSessionPreference,
  isDayAvoided,
} from "../lib/session-preference";

// Extracted from the Worker constructor (rather than left inline) so tests
// can call it directly without a real Valkey connection — same pattern as
// universe-refresh.worker.ts's processUniverseRefresh and rule-reset.worker.ts.
export async function processScanBot(
  job: Job<ScanBotJobPayload>,
): Promise<void> {
  const { botId, userId } = job.data;

  // Step 1 — Re-validate that the bot still exists, is owned by the expected
  // user, and is still ACTIVE. The `id` and `user_id` columns are both Int8
  // (bigint serialized as string); Kysely accepts string input for Int8.
  const bot = await db
    .selectFrom("bots")
    .where("id", "=", botId)
    .where("user_id", "=", userId)
    .where("status", "=", "ACTIVE")
    .select(["id", "user_id", "name"])
    .executeTakeFirst();

  if (!bot) {
    // Bot was paused, archived, deleted, or userId mismatch — safe no-op.
    console.log(
      JSON.stringify({
        level: "info",
        event: "scan.bot.noop",
        reason: "bot_not_active",
        botId,
        userId,
        jobId: job.id,
      }),
    );
    return;
  }

  // Step 2 — Confirm the user has at least one ACTIVE broker connection.
  // Without an active broker connection the bot cannot submit orders,
  // so there is no point proceeding through the scan pipeline.
  const brokerConn = await db
    .selectFrom("broker_connections")
    .where("user_id", "=", userId)
    .where("status", "=", "ACTIVE")
    .select(["id", "provider_name"])
    .executeTakeFirst();

  if (!brokerConn) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "scan.bot.noop",
        reason: "no_active_broker",
        botId,
        userId,
        jobId: job.id,
      }),
    );
    return;
  }

  // Step 3 — Fetch subscription tier to resolve the tier-aware daily AI call cap.
  // Always read from DB — never trust cache or job payload for billing-sensitive data.
  const subscription = await db
    .selectFrom("user_subscriptions")
    .where("user_id", "=", userId)
    .select("tier")
    .executeTakeFirst();

  if (!subscription) {
    console.log(
      JSON.stringify({
        level: "info",
        event: "scan.bot.noop",
        reason: "no_subscription",
        botId,
        userId,
        jobId: job.id,
      }),
    );
    return;
  }

  let dailyCap: number | null;
  switch (subscription.tier) {
    case "FREE_TRIAL":
      dailyCap = 40;
      break;
    case "TACHYON_HOSTED":
      dailyCap = 78;
      break;
    case "BYOK":
      dailyCap = null; // no cap — user's own API key
      break;
    default:
      dailyCap = 40; // safe default
  }

  // Both guards passed and cap resolved — bot is active, has a broker connection,
  // and has a subscription tier.
  console.log(
    JSON.stringify({
      level: "info",
      event: "scan.bot.received",
      botId,
      userId,
      botName: bot.name,
      brokerProvider: brokerConn.provider_name,
      subscriptionTier: subscription.tier,
      dailyCap,
      jobId: job.id,
    }),
  );

  // Steps 4-10 after the three guards above, resolve the bot's
  // relevant universe bucket(s), apply session/day narrowing, run the staleness gate,
  // and on anything but SKIPPED, run the deterministic filter chain
  // and log the resulting candidate list.. Wrapped in its own try/catch so
  // a failure here ends this bot's cycle for this tick without crashing
  // the worker or affecting any other bot's job (rule-reset.worker.ts's
  // per-item pattern).
  try {
    // Step 4 — resolve the bot's frame and relevant bucket(s).
    const botConfig = await db
      .selectFrom("bot_settings")
      .innerJoin("bots", "bots.current_settings_id", "bot_settings.id")
      .innerJoin("bot_frames", "bot_frames.id", "bots.frame_id")
      .where("bots.id", "=", botId)
      .select([
        "bot_frames.name as frame_name",
        "bot_settings.sub_sectors",
        "bot_settings.custom_watchlist",
        "bot_settings.exclusion_list",
        "bot_settings.dividend_preference",
        "bot_settings.short_interest_signal",
        "bot_settings.session_preference",
        "bot_settings.day_avoidance",
        "bot_settings.earnings_behavior",
      ])
      .executeTakeFirst();

    if (!botConfig) {
      throw new Error(`bot_settings/frame not found for bot ${botId}`);
    }

    const frame = FRAME_CONFIG[botConfig.frame_name as BotFrameName];
    if (!frame) {
      throw new Error(
        `Unknown frame "${botConfig.frame_name}" for bot ${botId}`,
      );
    }

    const subSectors = (botConfig.sub_sectors as string[] | null) ?? [];
    const customWatchlist =
      (botConfig.custom_watchlist as string[] | null) ?? [];
    const exclusionList = (botConfig.exclusion_list as string[] | null) ?? [];
    const dayAvoidance = (botConfig.day_avoidance as string[] | null) ?? [];
    // Casts: the DB-generated DividendPreference/ShortInterestSignal/
    // EarningsBehavior types (from @tachyonapp/tachyon-db, plain string
    // unions mirroring the Postgres ENUMs) share a name but are a distinct
    // declaration from tachyon-queue-types' enums of the same name — the
    // string values match (both trace back to the same Postgres ENUM
    // labels), but TypeScript won't unify them structurally.
    const dividendPreference = (botConfig.dividend_preference ??
      DividendPreference.NO_PREFERENCE) as DividendPreference;
    const shortInterestSignal = (botConfig.short_interest_signal ??
      ShortInterestSignal.IGNORE) as ShortInterestSignal;
    const earningsBehavior = (botConfig.earnings_behavior ??
      EarningsBehavior.NEUTRAL) as EarningsBehavior;

    const relevantParentSectors = resolveRelevantParentSectors(subSectors);
    const relevantBuckets = relevantParentSectors.flatMap((parentSector) =>
      frame.defaults.marketCapTiers.map((marketCapTier: MarketCapTier) => ({
        parentSector,
        marketCapTier,
      })),
    );

    // Step 5 — session/day narrowing. Deliberately separate from the
    // audit-writing staleness path below: this is an agent-preference
    // narrowing, not a staleness-gate event, and must produce NO
    // scan_audit_log row.
    if (
      isDayAvoided(dayAvoidance) ||
      !isWithinSessionPreference(botConfig.session_preference)
    ) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "scan.bot.noop",
          reason: "session_or_day_preference_excluded",
          botId,
          userId,
          jobId: job.id,
        }),
      );
      return;
    }

    // Step 6 — staleness gate. Exactly one aggregate outcome across every
    // relevant bucket (see staleness-gate.ts file header for the
    // most-protective aggregation rule).
    const gateResult = await evaluateStalenessGate(relevantBuckets);

    // Step 7 — audit write: exactly one scan_audit_log row, every branch,
    // including SKIPPED. as_of/age_seconds have no real value when no
    // bucket was ever cached — -1 is an explicit "unknown, no prior data"
    // sentinel, never a real elapsed age (which is always >= 0).
    await db
      .insertInto("scan_audit_log")
      .values({
        bot_id: botId,
        outcome: gateResult.outcome,
        bucket_key: gateResult.audit.bucketKey,
        tier: gateResult.audit.tier,
        as_of: gateResult.audit.asOf ?? new Date().toISOString(),
        age_seconds: gateResult.audit.ageSeconds ?? -1,
        threshold_seconds: gateResult.audit.thresholdSeconds,
        breaker_open: gateResult.audit.breakerOpen,
      })
      .execute();

    // Step 8 — SKIPPED: log + return early, same no-op convention as the
    // guards above.
    if (gateResult.outcome === "SKIPPED") {
      console.log(
        JSON.stringify({
          level: "info",
          event: "scan.bot.noop",
          reason: "staleness_gate_skipped",
          botId,
          userId,
          bucketKey: gateResult.audit.bucketKey,
          jobId: job.id,
        }),
      );
      return;
    }

    // Step 9 — filter chain: pure, deterministic, no network/DB I/O.
    const filterResult = runFilterChain({
      botSettings: {
        subSectors,
        customWatchlist,
        exclusionList,
        dividendPreference,
        shortInterestSignal,
        earningsBehavior,
      },
      frameMarketCapTiers: frame.defaults.marketCapTiers,
      frameLiquidityTier: frame.defaults.liquidityTier,
      candidateSymbols: gateResult.candidateSymbols,
    });

    // Step 10 — candidate-list handoff stub. Feature 11 (scoring/proposal
    // construction) does not exist yet — this only logs the handoff
    // payload at the point its entry point will eventually consume it.
    // TODO:: Feature 11 entry point — hand off candidates here.
    console.log(
      JSON.stringify({
        level: "info",
        event: "scan.bot.candidates_ready",
        botId,
        userId,
        staleneseGateOutcome: gateResult.outcome,
        candidateCount: filterResult.candidates.length,
        candidates: filterResult.candidates.map((c) => ({
          symbol: c.symbol,
          marketDataSnapshot: c.marketDataSnapshot,
        })),
        jobId: job.id,
      }),
    );
  } catch (err) {
    Sentry.captureException(err, { extra: { botId, userId, jobId: job.id } });
    console.error(
      JSON.stringify({
        level: "error",
        event: "scan.bot.pipeline-failed",
        botId,
        userId,
        error: err instanceof Error ? err.message : String(err),
        jobId: job.id,
      }),
    );
    // Failure here ends this bot's cycle for this tick — not a worker crash.
  }
}

export const scanBotWorker = new Worker<ScanBotJobPayload>(
  QUEUE_NAMES.SCAN_BOT,
  processScanBot,
  {
    connection: getBullMQConnectionOptions(),
    concurrency: Number(process.env.BULLMQ_CONCURRENCY ?? 5),
  },
);

// Structured error logging + Sentry capture on every failed job.
// job may be undefined if BullMQ fails before the job object is hydrated.
scanBotWorker.on("failed", (job, error) => {
  const context = {
    jobId: job?.id,
    queue: job?.queueName,
    attemptsMade: job?.attemptsMade,
    payload: job?.data,
  };
  console.error(
    JSON.stringify({
      level: "error",
      event: "job_failed",
      ...context,
      error: error.message,
      stack: error.stack,
    }),
  );
  Sentry.captureException(error, { extra: context });
});
