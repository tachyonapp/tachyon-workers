import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import {
  QUEUE_NAMES,
  type TrialExpiryCheckJobPayload,
  type NotificationType,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { db } from "../db";

export const trialExpiryWorker = new Worker<TrialExpiryCheckJobPayload>(
  QUEUE_NAMES.TRIAL_EXPIRY_CHECK,
  async (job) => {
    console.log(
      JSON.stringify({
        level: "info",
        event: "trial-expiry-check.started",
        triggeredAt: job.data.triggeredAt,
        jobId: job.id,
      }),
    );

    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const oneDayFromNow = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

    // Only process subscriptions that are still actively trialing —
    // already-suspended rows are skipped, making this job idempotent on re-run.
    const trialSubs = await db
      .selectFrom("user_subscriptions")
      .where("tier", "=", "FREE_TRIAL")
      .where("subscription_status", "=", "trialing")
      .select(["id", "user_id", "trial_expires_at"])
      .execute();

    for (const sub of trialSubs) {
      if (!sub.trial_expires_at) continue;

      const expiresAt = new Date(sub.trial_expires_at);

      try {
        if (expiresAt <= now) {
          // Trial expired — suspend user + pause all their ACTIVE bots atomically.
          await db.transaction().execute(async (trx) => {
            await trx
              .updateTable("user_subscriptions")
              .set({ subscription_status: "suspended", updated_at: new Date() })
              .where("id", "=", sub.id)
              .execute();

            await trx
              .updateTable("bots")
              .set({ status: "PAUSED", updated_at: new Date() })
              .where("user_id", "=", sub.user_id)
              .where("status", "=", "ACTIVE")
              .execute();
          });

          // TODO: Feature 17 — finalize push notification delivery
          const _notificationType: NotificationType = "TRIAL_EXPIRED";
          console.log(
            JSON.stringify({
              level: "info",
              event: "trial-expiry-check.expired",
              userId: sub.user_id,
              notificationType: _notificationType,
            }),
          );
        } else if (expiresAt <= oneDayFromNow) {
          // TODO: Feature 17 — finalize push notification delivery
          const _notificationType: NotificationType = "TRIAL_EXPIRING_1D";
          console.log(
            JSON.stringify({
              level: "info",
              event: "trial-expiry-check.expiring_soon",
              userId: sub.user_id,
              notificationType: _notificationType,
              expiresAt: expiresAt.toISOString(),
            }),
          );
        } else if (expiresAt <= sevenDaysFromNow) {
          // TODO: Feature 17 — finalize push notification delivery
          const _notificationType: NotificationType = "TRIAL_EXPIRING_7D";
          console.log(
            JSON.stringify({
              level: "info",
              event: "trial-expiry-check.expiring_soon",
              userId: sub.user_id,
              notificationType: _notificationType,
              expiresAt: expiresAt.toISOString(),
            }),
          );
        }
        // > 7 days remaining — no action
      } catch (err) {
        // Per-user isolation: one user's failure does not abort the entire job.
        Sentry.captureException(err, {
          extra: { userId: sub.user_id, subId: sub.id },
        });
        console.error(
          JSON.stringify({
            level: "error",
            event: "trial-expiry-check.user_error",
            userId: sub.user_id,
            error: String(err),
          }),
        );
      }
    }

    console.log(
      JSON.stringify({
        level: "info",
        event: "trial-expiry-check.complete",
        processed: trialSubs.length,
        jobId: job.id,
      }),
    );
  },
  {
    connection: getBullMQConnectionOptions(),
    concurrency: 1,
  },
);

trialExpiryWorker.on("failed", (job, error) => {
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
