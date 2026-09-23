/**
 * Manual Universe Refresh Trigger
 *
 * Usage: npx tsx scripts/trigger-universe-refresh.ts
 *
 * What it does:
 * Enqueues a single `universe-refresh` job, bypassing the cron
 * (`58,3,8,13,18,23,28,33,38,43,48,53 13-21 * * 1-5`). The `universe-refresh`
 * worker process must already be running (`npm run dev` or the built worker)
 * to pick the job up — this script only enqueues, it does not process.
 *
 * When to use it:
 * - Local dev, outside market hours or with UNIVERSE_REFRESH_ENABLED unset —
 *   populate the Valkey bucket cache on demand instead of waiting for the
 *   next cron tick (up to ~5 min, and only during 13-21 UTC on weekdays).
 * - Testing end-to-end (bucket cache -> staleness gate -> filter
 *   chain) without editing the cron pattern.
 *
 * Does not bypass UNIVERSE_REFRESH_ENABLED — if that env var isn't "true" on
 * the running worker process, the job will still no-op per the dark-launch
 * gate in universe-refresh.worker.ts.
 *
 * Prerequisites: `docker compose up postgres valkey` (from tachyon-infra) and
 * the worker process running locally.
 */

import { Queue } from "bullmq";
import {
  QUEUE_NAMES,
  type UniverseRefreshJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../src/connection";

async function main() {
  const queue = new Queue(QUEUE_NAMES.UNIVERSE_REFRESH, {
    connection: getBullMQConnectionOptions(),
  });

  const job = await queue.add(QUEUE_NAMES.UNIVERSE_REFRESH, {
    triggeredAt: new Date().toISOString(),
  } as UniverseRefreshJobPayload);

  console.log(`Enqueued universe-refresh job ${job.id}`);

  await queue.close();
}

main().catch((err) => {
  console.error("trigger-universe-refresh failed:", err);
  process.exit(1);
});
