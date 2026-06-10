import { Worker, type Job } from "bullmq";
import * as Sentry from "@sentry/node";
import { sql, type SqlBool } from "kysely";
import {
  QUEUE_NAMES,
  type RuleResetJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { db } from "../db";

export async function processRuleReset(
  job: Job<RuleResetJobPayload>,
): Promise<void> {
  console.log(
    JSON.stringify({
      level: "info",
      event: "rule-reset.started",
      triggeredAt: job.data.triggeredAt,
    }),
  );

  const stoodDownBots = await db
    .selectFrom("bots")
    .where("status", "=", "STOOD_DOWN")
    .select(["id", "user_id", "recovery_mode_applied", "recovery_mode_active_until"])
    .execute();

  console.log(
    JSON.stringify({
      level: "info",
      event: "rule-reset.bots-found",
      count: stoodDownBots.length,
    }),
  );

  for (const bot of stoodDownBots) {
    try {
      await db.transaction().execute(async (tx) => {
        const now = new Date();
        const recoveryMode = bot.recovery_mode_applied;
        const recoveryUntil = bot.recovery_mode_active_until
          ? new Date(bot.recovery_mode_active_until)
          : null;

        // Guard: if bot was stood down due to MAX_DRAWDOWN_EXCEEDED and still has an open
        // position, do NOT reset — bot must remain STOOD_DOWN until the position closes.
        // Feature 14 is responsible for clearing STOOD_DOWN after the drawdown exit fills.
        const runtimeData = await tx
          .selectFrom("bot_runtime_data")
          .where("bot_id", "=", bot.id)
          .where(sql<SqlBool>`trading_day = CURRENT_DATE`)
          .select("standdown_reason")
          .executeTakeFirst();

        if (runtimeData?.standdown_reason === "MAX_DRAWDOWN_EXCEEDED") {
          const openPosition = await tx
            .selectFrom("positions")
            .where("bot_id", "=", bot.id)
            .where("status", "=", "OPEN")
            .select("id")
            .executeTakeFirst();

          if (openPosition) {
            console.log(
              JSON.stringify({
                level: "info",
                event: "rule-reset.skipped-drawdown",
                botId: bot.id,
                reason:
                  "Open position exists; drawdown standown persists until position closes (Feature 14)",
              }),
            );
            return;
          }
        }

        const clearRecovery = !!(recoveryUntil && recoveryUntil < now);

        let newStatus: "ACTIVE" | "STOOD_DOWN" = "ACTIVE";
        let newRecoveryUntil: Date | null = null;
        let newRecoveryApplied: "NORMAL" | "MORE_CONSERVATIVE_2D" | "STAND_DOWN_1W" | null = null;

        if (clearRecovery || !recoveryMode) {
          newStatus = "ACTIVE";
          newRecoveryUntil = null;
          newRecoveryApplied = null;
        } else if (recoveryMode === "NORMAL") {
          newStatus = "ACTIVE";
          newRecoveryUntil = null;
          newRecoveryApplied = null;
        } else if (recoveryMode === "MORE_CONSERVATIVE_2D") {
          newStatus = "ACTIVE";
          newRecoveryApplied = "MORE_CONSERVATIVE_2D";
          newRecoveryUntil = new Date(now);
          newRecoveryUntil.setDate(newRecoveryUntil.getDate() + 2);
        } else if (recoveryMode === "STAND_DOWN_1W") {
          if (!recoveryUntil) {
            // First cron run after standown — set the 7-day window
            newStatus = "STOOD_DOWN";
            newRecoveryUntil = new Date(now);
            newRecoveryUntil.setDate(newRecoveryUntil.getDate() + 7);
            newRecoveryApplied = "STAND_DOWN_1W";
          } else if (recoveryUntil > now) {
            // Still within the 1-week stand-down window
            newStatus = "STOOD_DOWN";
            newRecoveryUntil = recoveryUntil;
            newRecoveryApplied = "STAND_DOWN_1W";
          } else {
            // 1-week window has elapsed — reset to ACTIVE
            newStatus = "ACTIVE";
            newRecoveryUntil = null;
            newRecoveryApplied = null;
          }
        }

        await tx
          .updateTable("bots")
          .set({
            status: newStatus,
            recovery_mode_active_until: newRecoveryUntil,
            recovery_mode_applied: newRecoveryApplied,
          })
          .where("id", "=", bot.id)
          .execute();

        await tx
          .insertInto("rule_audit_log")
          .values({
            bot_id: bot.id,
            user_id: bot.user_id,
            evaluation_type: "standdown_reset",
            passed: true,
            rejection_reason: null,
            rule_violations: JSON.stringify([]),
            input_snapshot: JSON.stringify({
              triggeredAt: job.data.triggeredAt,
              recoveryMode,
              newStatus,
              newRecoveryUntil: newRecoveryUntil?.toISOString() ?? null,
            }),
            evaluated_at: now,
          })
          .execute();
      });
    } catch (err) {
      Sentry.captureException(err, { extra: { botId: bot.id } });
      console.error(
        JSON.stringify({
          level: "error",
          event: "rule-reset.bot-failed",
          botId: bot.id,
          error: String(err),
        }),
      );
      // Failure for one bot does not abort the batch — continue to next
    }
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "rule-reset.completed",
      processed: stoodDownBots.length,
    }),
  );
}

export const ruleResetWorker = new Worker<RuleResetJobPayload>(
  QUEUE_NAMES.RULE_RESET,
  processRuleReset,
  {
    connection: getBullMQConnectionOptions(),
    concurrency: 1,
  },
);

ruleResetWorker.on("failed", (job, err) => {
  Sentry.captureException(err, { extra: { jobId: job?.id } });
  console.error(
    JSON.stringify({
      level: "error",
      event: "rule-reset.job-failed",
      error: String(err),
    }),
  );
});
