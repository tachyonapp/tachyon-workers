/**
 * scan-dispatch.worker.ts — Scan Dispatch Worker
 *
 * Role: "Fan-out coordinator" — fired on a cron schedule, this worker queries
 * the database for every ACTIVE bot and enqueues one `scan:bot` job for each.
 * It never does any market analysis itself; it only delegates.
 *
 * Cron schedule: every 15 minutes during NYSE trading hours (Mon–Fri, 14:00–21:00 UTC).
 * The cron fires broadly across that window, but the first thing the processor
 * does is check isMarketHours() — any tick that lands outside 9:30 AM–4:00 PM ET
 * is a safe no-op. This avoids needing a tighter cron expression while still
 * ensuring no scans happen when the market is closed.
 *
 * Fan-out strategy: all `scan:bot` jobs are enqueued in a single atomic
 * Queue.addBulk() call (one Valkey pipeline round-trip), rather than one
 * queue.add() call per bot. This keeps latency proportional to one network
 * call regardless of how many bots are active.
 *
 * Concurrency: 1 — only one dispatch job should run at a time to avoid
 * duplicate fan-outs if a job is slow and the next cron tick fires.
 */

import { Worker } from 'bullmq';
import * as Sentry from '@sentry/node';
import {
  QUEUE_NAMES,
  type ScanDispatchJobPayload,
} from '@tachyonapp/tachyon-queue-types';
import { getBullMQConnectionOptions } from '../connection';
import { scanBotQueue } from '../queues/scan-bot.queue';
import { isMarketHours } from '../lib/market-hours';
import { db } from '../db';

/**
 * Queries the database for all bots currently in ACTIVE status.
 * Only ACTIVE bots are eligible for scanning — DRAFT, PAUSED, and ARCHIVED
 * bots are intentionally excluded.
 *
 * Returns only the fields needed by the scan:bot payload (id + user_id) to
 * keep the Valkey job payload small. Credentials and financial data are
 * never included in queue payloads.
 */
async function getActiveBots(): Promise<Array<{ id: string; user_id: string }>> {
  return db
    .selectFrom('bots')
    .where('status', '=', 'ACTIVE')
    .select(['id', 'user_id'])
    .execute();
}

export const scanDispatchWorker = new Worker<ScanDispatchJobPayload>(
  QUEUE_NAMES.SCAN_DISPATCH,
  async (job) => {
    // Guard: skip the job entirely if the market is closed.
    // This is the primary market-hours enforcement for the scanning pipeline.
    if (!isMarketHours()) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'scan.dispatch.noop',
          reason: 'outside_market_hours',
          jobId: job.id,
        }),
      );
      return;
    }

    const activeBots = await getActiveBots();

    if (activeBots.length === 0) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'scan.dispatch.noop',
          reason: 'no_active_bots',
          jobId: job.id,
        }),
      );
      return;
    }

    // Single atomic Valkey pipeline call — not N round-trips.
    // addBulk() batches all enqueue commands into one round-trip,
    // which is important when hundreds of bots are active.
    await scanBotQueue.addBulk(
      activeBots.map((bot) => ({
        name: 'scan-bot',
        data: { botId: bot.id, userId: bot.user_id },
      })),
    );

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'scan.dispatch.complete',
        botCount: activeBots.length,
        jobId: job.id,
      }),
    );
  },
  { connection: getBullMQConnectionOptions(), concurrency: 1 },
);

// Structured error logging + Sentry capture on every failed job.
// job may be undefined if BullMQ fails before the job object is hydrated.
scanDispatchWorker.on('failed', (job, error) => {
  const context = {
    jobId: job?.id,
    queue: job?.queueName,
    attemptsMade: job?.attemptsMade,
    payload: job?.data,
  };
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'job_failed',
      ...context,
      error: error.message,
      stack: error.stack,
    }),
  );
  Sentry.captureException(error, { extra: context });
});
