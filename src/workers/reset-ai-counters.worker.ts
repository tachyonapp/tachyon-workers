import { Worker } from "bullmq";
import { DateTime } from "luxon";
import {
  QUEUE_NAMES,
  type ResetAiCountersJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { db } from "../db";

export const resetAiCountersWorker = new Worker<ResetAiCountersJobPayload>(
  QUEUE_NAMES.RESET_AI_COUNTERS,
  async (job) => {
    const today = DateTime.now().setZone("America/New_York").toISODate()!;
    const result = await db
      .updateTable("bot_runtime_data")
      .set({ ai_calls_today: 0 })
      .where("trading_day", "<", new Date(today))
      .where("ai_calls_today", ">", 0)
      .executeTakeFirst();

    console.log(
      JSON.stringify({
        level: "info",
        event: "ai_counters.reset",
        cutoffDate: today,
        rowsUpdated: result?.numUpdatedRows?.toString() ?? "0",
        jobId: job.id,
      }),
    );
  },
  { connection: getBullMQConnectionOptions(), concurrency: 1 },
);
