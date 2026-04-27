/**
 * index.ts — Worker Orchestration Entry Point
 *
 * Responsibilities (in startup order):
 * 1. Initialize Sentry error capture (gated on SENTRY_DSN — no-op locally)
 * 2. Start the Valkey heartbeat so the infra layer can detect live worker instances
 * 3. Import all 6 worker processors (side effect: each opens a Valkey connection
 *    and begins polling its queue)
 * 4. Register cron job schedulers (idempotent — safe on every restart)
 * 5. Register SIGTERM/SIGINT handlers for graceful shutdown
 *
 * Shutdown sequence (SIGTERM or SIGINT):
 * 1. Stop heartbeat (removes the Valkey key so the instance is no longer visible)
 * 2. Close all worker processors (drain in-flight jobs, stop polling)
 * 3. Exit 0 — DigitalOcean App Platform expects exit within 30 s before SIGKILL
 *
 * Note on Sentry initialization order:
 * With CommonJS output, TypeScript compiles all static `import` statements to
 * `require()` calls at the top of the generated file. This means worker modules
 * are required before Sentry.init() executes at runtime. In practice this is
 * safe: workers only call Sentry.captureException() during job failures, which
 * always happen after main() has completed startup and Sentry has been initialized.
 */

import * as Sentry from "@sentry/node";

// Initialize Sentry before workers start processing jobs.
// Gated on SENTRY_DSN — absent in local dev, set in staging and production.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0, // Error capture only for MVP — no performance monitoring
  });
  console.log(JSON.stringify({ level: "info", event: "sentry.initialized" }));
}

// Importing worker modules is a side effect: each opens a Valkey connection
// via BullMQ and begins polling its respective queue for jobs.
import { scanDispatchWorker } from "./workers/scan-dispatch.worker";
import { scanBotWorker } from "./workers/scan-bot.worker";
import { expiryWorker } from "./workers/expiry.worker";
import { reconciliationWorker } from "./workers/reconciliation.worker";
import { notificationWorker } from "./workers/notification.worker";
import { summaryWorker } from "./workers/summary.worker";
import { resetAiCountersWorker } from "./workers/reset-ai-counters.worker";

import { registerScheduledJobs } from "./scheduler";
import { gracefulShutdown } from "./shutdown";
import { createHeartbeat, stopHeartbeat } from "./heartbeat";

const INSTANCE_ID = process.env.HOSTNAME || `worker-${process.pid}`;
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

const allWorkers = [
  scanDispatchWorker,
  scanBotWorker,
  expiryWorker,
  reconciliationWorker,
  notificationWorker,
  summaryWorker,
  resetAiCountersWorker,
];

async function main(): Promise<void> {
  console.log(
    JSON.stringify({
      level: "info",
      event: "workers.starting",
      instanceId: INSTANCE_ID,
    }),
  );

  // Anthropic key validation
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      JSON.stringify({
        level: "fatal",
        event: "startup.failed",
        error: "ANTHROPIC_API_KEY is required for the Tachyon-hosted brain",
      }),
    );
    process.exit(1);
  }

  // Start the heartbeat — writes a TTL'd key to Valkey every 30 s so the
  // infrastructure layer can detect whether this worker process is alive.
  const heartbeat = await createHeartbeat(INSTANCE_ID, HEARTBEAT_INTERVAL_MS);

  // Register cron schedulers (idempotent via upsertJobScheduler — safe on
  // every restart regardless of how many worker instances are running).
  await registerScheduledJobs();

  console.log(
    JSON.stringify({
      level: "info",
      event: "workers.ready",
      count: allWorkers.length,
      instanceId: INSTANCE_ID,
    }),
  );

  // Graceful shutdown: stop heartbeat first (removes visibility), then drain
  // all in-flight jobs before exiting. Hard timeout enforced in gracefulShutdown.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(
      JSON.stringify({ level: "info", event: "signal.received", signal }),
    );
    await stopHeartbeat(heartbeat);
    await gracefulShutdown(allWorkers);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: "fatal",
      event: "startup.failed",
      error: String(err),
    }),
  );
  process.exit(1);
});
