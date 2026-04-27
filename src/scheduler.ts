import { resetAiCountersQueue } from "./queues";
import type { ResetAiCountersJobPayload } from "@tachyonapp/tachyon-queue-types";
import { scanDispatchQueue } from "./queues/scan-dispatch.queue";
import { expiryQueue } from "./queues/expiry.queue";
import { reconciliationQueue } from "./queues/reconciliation.queue";
import { summaryQueue } from "./queues/summary.queue";
import type {
  ScanDispatchJobPayload,
  ExpiryJobPayload,
  ReconciliationJobPayload,
  SummaryJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { QUEUE_NAMES } from "@tachyonapp/tachyon-queue-types";

const { SCAN_DISPATCH, RESET_AI_COUNTERS, EXPIRY, SUMMARY, RECONCILIATION } =
  QUEUE_NAMES;

/**
 * Register all recurring cron jobs.
 * Uses upsertJobScheduler (BullMQ v5 API) — idempotent, safe to call on every restart.
 * Calling this on every worker instance start is the recommended BullMQ pattern.
 * BullMQ guarantees exactly one job per cron tick regardless of instance count via
 * idempotent Valkey-backed registration and deterministic job IDs.
 */
export async function registerScheduledJobs(): Promise<void> {
  await scanDispatchQueue.upsertJobScheduler(
    "scan-dispatch-cron",
    { pattern: "*/5 14-21 * * 1-5" },
    {
      name: SCAN_DISPATCH,
      data: { triggeredAt: new Date().toISOString() } as ScanDispatchJobPayload,
    },
  );

  // NOTE scan-bot is NOT cron-scheduled — enqueued by the scan-dispatch dispatcher

  await expiryQueue.upsertJobScheduler(
    "expiry-cron",
    { pattern: "* * * * *" },
    {
      name: EXPIRY,
      data: { triggeredAt: new Date().toISOString() } as ExpiryJobPayload,
    },
  );

  await reconciliationQueue.upsertJobScheduler(
    "reconciliation-cron",
    { pattern: "*/5 * * * *" },
    {
      name: RECONCILIATION,
      data: {
        triggeredAt: new Date().toISOString(),
        scope: "full",
      } as ReconciliationJobPayload,
    },
  );

  // summary — 21:05 UTC = 4:05 PM EST (winter) / 5:05 PM EDT (summer)
  // Always fires after market close regardless of DST
  await summaryQueue.upsertJobScheduler(
    "summary-cron",
    { pattern: "5 21 * * 1-5" },
    {
      name: SUMMARY,
      data: {
        triggeredAt: new Date().toISOString(),
        scope: "eod",
      } as SummaryJobPayload,
    },
  );

  // 05:00 UTC = midnight ET (standard time). During EDT, fires at 01:00 ET — acceptable for MVP.
  await resetAiCountersQueue.upsertJobScheduler(
    "reset-ai-counters-cron",
    { pattern: "0 5 * * 1-5" },
    {
      name: RESET_AI_COUNTERS,
      data: {
        triggeredAt: new Date().toISOString(),
      } as ResetAiCountersJobPayload,
    },
  );

  console.log(
    JSON.stringify({
      level: "info",
      event: "scheduler.registered",
      queues: [
        SCAN_DISPATCH,
        EXPIRY,
        RECONCILIATION,
        SUMMARY,
        RESET_AI_COUNTERS,
      ],
    }),
  );
}
