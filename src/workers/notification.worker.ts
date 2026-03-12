/**
 * Notification Worker
 *
 * Role: "Push notification dispatcher" — processes on-demand notification jobs
 * enqueued by the API or other workers when an actionable event occurs.
 *
 * Unlike the cron-driven workers, this queue is purely event-driven. Jobs are
 * enqueued by other parts of the system at the moment an event happens:
 * - API enqueues PROPOSAL_READY when a new trade proposal is created for a user
 * - Workers enqueue ORDER_FILLED / ORDER_REJECTED after order state transitions
 * - Workers enqueue BOT_STOOD_DOWN when a bot hits a daily loss/gain limit
 * - Workers enqueue FUNDING_COMPLETED / FUNDING_FAILED after transfer events
 *
 * Each job targets a single user (userId) and carries a referenceId pointing
 * to the proposal, order, or funding event that triggered the notification.
 *
 * Implementation (Notification Service TDD):
 * The full implementation — resolving the user's push token, constructing the
 * notification payload, and sending via the push provider — is scoped to the
 * Notification Service TDD. User notification preferences (push_enabled,
 * quiet_hours in the user_settings table) must be respected before sending.
 *
 * Concurrency: BULLMQ_CONCURRENCY (default 5) — notifications are independent
 * per user so parallel processing is safe and desirable for low latency.
 */

import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  type NotificationJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const notificationWorker = new Worker<NotificationJobPayload>(
  QUEUE_NAMES.NOTIFICATION,
  async (job) => {
    const { userId, type, referenceId } = job.data;

    // TODO: Notification Service TDD):
    // 1. Look up user_settings for userId — check push_enabled and quiet_hours.
    // 2. If push is disabled or user is in quiet hours, skip silently.
    // 3. Resolve the user's device push token.
    // 4. Construct the notification payload based on `type` and `referenceId`.
    // 5. Send via the push notification provider.
    console.log(
      JSON.stringify({
        level: "info",
        event: "notification.received",
        userId,
        type,
        referenceId,
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
notificationWorker.on("failed", (job, error) => {
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
