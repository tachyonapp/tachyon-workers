/**
 * Manual Scan Bot Trigger
 *
 * Usage: npx tsx scripts/trigger-scan-bot.ts --botId <id> --userId <id>
 *
 * What it does:
 * Enqueues a single `scan-bot` job for one specific bot, outside the normal
 * `scan-dispatch` fan-out (which enqueues one job per active bot, every 5 min,
 * only during market hours). The `scan-bot` worker process must already be
 * running to pick the job up — this script only enqueues, it does not process.
 *
 * Does NOT bypass any of scan-bot.worker.ts's own guards — ownership/ACTIVE
 * check, broker-connection check, subscription-tier cap resolution, and (once
 * wired) the staleness gate all still run exactly as they would for a job
 * enqueued by scan-dispatch. This only skips waiting for the next dispatch
 * tick and isolates one bot instead of the whole active-bot fleet.
 *
 * When to use it:
 * - Debugging one agent's staleness-gate/filter-chain behavior without
 *   the rest of the fleet's jobs mixed into the same tick.
 * - Local dev outside market hours, when scan-dispatch's own market-hours
 *   guard would otherwise no-op.
 *
 * Prerequisites: `docker compose up postgres valkey` (from tachyon-infra) and
 * the worker process running locally.
 */

import { Queue } from "bullmq";
import {
  QUEUE_NAMES,
  type ScanBotJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../src/connection";

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const botId = readArg("botId");
  const userId = readArg("userId");

  if (!botId || !userId) {
    console.error(
      "Usage: npx tsx scripts/trigger-scan-bot.ts --botId <id> --userId <id>",
    );
    process.exit(1);
  }

  const queue = new Queue(QUEUE_NAMES.SCAN_BOT, {
    connection: getBullMQConnectionOptions(),
  });

  const job = await queue.add(QUEUE_NAMES.SCAN_BOT, {
    botId,
    userId,
  } as ScanBotJobPayload);

  console.log(`Enqueued scan-bot job ${job.id} for botId=${botId}`);

  await queue.close();
}

main().catch((err) => {
  console.error("trigger-scan-bot failed:", err);
  process.exit(1);
});
