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
    { pattern: "*/15 14-21 * * 1-5" },
    {
      name: "scan-dispatch",
      data: { triggeredAt: new Date().toISOString() } as ScanDispatchJobPayload,
    },
  );

  // NOTE scan-bot is NOT cron-scheduled — enqueued by the scan-dispatch dispatcher

  await expiryQueue.upsertJobScheduler(
    "expiry-cron",
    { pattern: "* * * * *" },
    {
      name: "expiry",
      data: { triggeredAt: new Date().toISOString() } as ExpiryJobPayload,
    },
  );

  await reconciliationQueue.upsertJobScheduler(
    "reconciliation-cron",
    { pattern: "*/5 * * * *" },
    {
      name: "reconciliation",
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
      name: "summary",
      data: {
        triggeredAt: new Date().toISOString(),
        scope: "eod",
      } as SummaryJobPayload,
    },
  );

  console.log(
    JSON.stringify({
      level: "info",
      event: "scheduler.registered",
      queues: ["scan-dispatch", "expiry", "reconciliation", "summary"],
    }),
  );
}
