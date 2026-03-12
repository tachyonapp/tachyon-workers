import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const reconciliationQueue = new Queue(QUEUE_NAMES.RECONCILIATION, {
  connection: getBullMQConnectionOptions(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
});
