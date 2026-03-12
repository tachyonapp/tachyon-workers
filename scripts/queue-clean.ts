/**
 * Queue Cleanup Util
 *
 * Usage: npx tsx scripts/queue-clean.ts [--grace <ms>] [--limit <n>]
 *
 * What it does:
 * Connects to Valkey and cleans completed + failed jobs from all queues.
 * Safe to run manually against production — only removes job history, not active/waiting jobs.
 * Only intended for production. Staging clean up can be done via Bull Board
 *
 * When to use it:
 * - Bull Board goes down or is unavailable — production doesn't mount Bull Board,
 * so this is the only way to manually flush job history if it piles up unexpectedly
 *
 * - After a runaway bug or major incident — if a bug caused thousands of failed jobs
 * to accumulate (e.g., a bad deploy that caused every scan-bot job to fail for hours),
 * this clears the noise so you can see the current state clearly
 *
 * - Storage pressure — BullMQ's removeOnComplete: { count: 1000 } and removeOnFail: { count: 500 }
 * per-queue limits handle routine cleanup automatically. You'd only need the script if those
 * limits weren't enough (e.g., a queue somehow accumulated far beyond its limit before the
 * limits were set)
 *
 * - Pre-deploy hygiene — before a major schema change or queue rename, you might want a clean slate
 */

import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../src/connection";

const args = process.argv.slice(2);
const graceIdx = args.indexOf("--grace");
const limitIdx = args.indexOf("--limit");
const grace = graceIdx !== -1 ? Number(args[graceIdx + 1]) : 0;
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : 1000;

const connection = getBullMQConnectionOptions();
const queueNames = Object.values(QUEUE_NAMES);

async function clean() {
  console.log(
    `Cleaning queues with grace=${grace}ms, limit=${limit} per queue`,
  );
  for (const name of queueNames) {
    const queue = new Queue(name, { connection });
    const completed = await queue.clean(grace, limit, "completed");
    const failed = await queue.clean(grace, limit, "failed");
    console.log(
      `${name}: removed ${completed.length} completed, ${failed.length} failed`,
    );
    await queue.close();
  }
  console.log("Done.");
}

clean().catch((err) => {
  console.error("queue-clean failed:", err);
  process.exit(1);
});
