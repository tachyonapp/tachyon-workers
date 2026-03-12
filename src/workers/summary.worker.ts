/**
 * EOD Summary Worker
 *
 * Role: "End-of-day reporter" — generates daily trading summaries for each bot
 * after market close. Fires once per trading day at 21:05 UTC (Mon–Fri).
 *
 * Why 21:05 UTC?
 * - NYSE closes at 4:00 PM ET.
 * - 4:00 PM EST = 21:00 UTC (winter), 4:00 PM EDT = 20:00 UTC (summer).
 * - 21:05 UTC is safely after close in both EST and EDT — no DST math needed.
 *
 * Scope variants:
 * - 'eod'    — end-of-day report; triggered by the daily cron at 21:05 UTC.
 * - 'weekly' — weekly recap; would be triggered by a separate Monday morning
 *              job (not yet scheduled — reserved for a future feature).
 *
 * Market-hours defensive check:
 * A market-hours guard is included below as a defensive sanity check only.
 * The cron fires at 21:05 UTC which is always post-close, so this check will
 * never be true in normal operation. It is retained to make the intent explicit
 * and to catch accidental manual job enqueueing during market hours.
 *
 * TODO:
 * Implementation (Reporting Service TDD):
 * The full report generation logic — aggregating per-bot PnL, trade counts,
 * and win/loss stats from bot_runtime_data, then formatting and delivering
 * the EOD summary — is scoped to the Reporting Service TDD (Feature 7+).
 *
 * Concurrency: 1 — EOD summaries are generated once globally per trading day.
 * Running multiple summary jobs concurrently would produce duplicate reports.
 */

import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  type SummaryJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { isMarketHours } from "../lib/market-hours";

export const summaryWorker = new Worker<SummaryJobPayload>(
  QUEUE_NAMES.SUMMARY,
  async (job) => {
    const { tradingDate, scope } = job.data;

    // Defensive guard — the cron always fires post-close, so this should
    // never be true. If it is, something unusual has happened (e.g., manual
    // enqueueing or a timezone misconfiguration). Log and proceed anyway,
    // since generating a partial-day summary is preferable to dropping it.
    if (isMarketHours()) {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "summary.market_open_warning",
          reason: "summary_fired_during_market_hours",
          tradingDate,
          scope,
          jobId: job.id,
        }),
      );
    }

    // TODO: (Reporting Service TDD):
    // 1. Aggregate per-bot PnL, proposal counts, approval rates, and win/loss
    //    stats from bot_runtime_data for the given tradingDate.
    // 2. Format the report payload.
    // 3. Persist the report and trigger any downstream delivery (push, email).
    console.log(
      JSON.stringify({
        level: "info",
        event: "summary.received",
        tradingDate,
        scope,
        jobId: job.id,
      }),
    );
  },
  {
    connection: getBullMQConnectionOptions(),
    concurrency: 1,
  },
);

// Structured error logging + Sentry capture on every failed job.
// job may be undefined if BullMQ fails before the job object is hydrated.
summaryWorker.on("failed", (job, error) => {
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
