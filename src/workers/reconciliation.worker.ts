/**
 * Reconciliation Worker
 *
 * Role: "Ledger consistency checker" — runs every 5 minutes (24/7 cron) to
 * detect and correct discrepancies between Tachyon's internal state and the
 * broker's reported positions, orders, and balances.
 *
 * Why continuous (not market-hours only)?
 * Reconciliation is a safety net, not a trading operation. Discrepancies can
 * arise at any time — from broker webhooks arriving out of order, network
 * failures during order submission, or partial fills that weren't captured.
 * Running continuously ensures the ledger stays accurate even during off-hours
 * events like pre/post-market activity or broker system maintenance.
 *
 * Scopes:
 * - 'full'    — reconcile all users/bots. Used by the scheduled cron.
 * - 'partial' — reconcile a single user. Can be triggered on-demand via the
 *               API (e.g., after a user's broker connection is re-authenticated).
 *               userId is required when scope is 'partial'.
 *
 * Implementation TODO:
 * The full reconciliation logic — diffing internal order/position state against
 * broker API responses and emitting corrective events — is implemented in the
 * trading-domain TDD.
 *
 * Concurrency: 1 — reconciliation performs broad reads across the entire
 * orders and positions table. Running multiple reconciliations concurrently
 * risks redundant work and conflicting writes.
 */

import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  type ReconciliationJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const reconciliationWorker = new Worker<ReconciliationJobPayload>(
  QUEUE_NAMES.RECONCILIATION,
  async (job) => {
    const { scope, userId } = job.data;

    // TODO: Diff internal order/position/balance state against
    // broker API responses and emit corrective events for any discrepancies.
    // When scope = 'partial', scope the query to the provided userId.
    console.log(
      JSON.stringify({
        level: "info",
        event: "reconciliation.received",
        scope,
        userId: userId ?? "all",
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
reconciliationWorker.on("failed", (job, error) => {
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
