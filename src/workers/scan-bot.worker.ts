/**
 * Per-Bot Scan Worker
 *
 * Role: "Individual bot scanner" — processes one scan-bot job per bot.
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
 * Two-step guard:
 * 1. Confirm the bot still exists, belongs to the given userId, and is ACTIVE.
 * 2. Confirm the user has at least one ACTIVE broker connection.
 * If either check fails, the job returns early as a safe no-op — no error,
 * no retry, no Sentry alert. Stale jobs are expected and benign.
 *
 * Concurrency: BULLMQ_CONCURRENCY (default 5) — multiple scan-bot jobs can
 * run in parallel within a single worker process. Each job is isolated to its
 * own bot, so there is no shared state between concurrent executions.
 *
 * Future: TODO:: universe filtering → scoring → proposal construction are implemented
 * in the trading-domain TDD. This file will be extended then.
 */

import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  type ScanBotJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { db } from "../db";

export const scanBotWorker = new Worker<ScanBotJobPayload>(
  QUEUE_NAMES.SCAN_BOT,
  async (job) => {
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

    // Both guards passed — the bot is active and has a broker connection.
    // TODO:: universe filtering → scoring → proposal construction.
    // The full trading pipeline will be implemented in the trading-domain TDD.
    console.log(
      JSON.stringify({
        level: "info",
        event: "scan.bot.received",
        botId,
        userId,
        botName: bot.name,
        brokerProvider: brokerConn.provider_name,
        jobId: job.id,
      }),
    );
  },
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
