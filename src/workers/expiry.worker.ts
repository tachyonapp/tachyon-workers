/**
 * Trade Proposal Expiry Worker
 *
 * Role: "Proposal janitor" — runs every minute (24/7 cron) and marks stale
 * PENDING trade proposals as EXPIRED.
 *
 * Why continuous (not market-hours only)?
 * Proposals expire based on wall-clock time, not market session. A proposal
 * created just before market close might have an expires_at that falls during
 * off-hours. Running this worker 24/7 ensures proposals are cleaned up promptly
 * regardless of when they were created.
 *
 * Implementation TODO:
 * The full expiry logic — querying trade_proposals WHERE status = 'PENDING' AND
 * expires_at < NOW(), updating each to EXPIRED, and emitting any required
 * downstream events — is implemented in the trading-domain TDD.
 * The expires_at index ensures the query is efficient.
 *
 * Concurrency: BULLMQ_CONCURRENCY (default 5). Since expiry jobs are bulk
 * sweeps rather than per-entity jobs, concurrency above 1 mainly covers the
 * case where a previous job stalls and a new one fires before it completes.
 */

import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  type ExpiryJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const expiryWorker = new Worker<ExpiryJobPayload>(
  QUEUE_NAMES.EXPIRY,
  async (job) => {
    // TODO: Query trade_proposals WHERE status = 'PENDING'
    // AND expires_at < NOW() and update each to status = 'EXPIRED'.
    // The expires_at index (Feature 2) ensures this is a fast index scan.
    console.log(
      JSON.stringify({
        level: "info",
        event: "expiry.received",
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
expiryWorker.on("failed", (job, error) => {
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
