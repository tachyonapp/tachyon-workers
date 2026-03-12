import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const expiryQueue = new Queue(QUEUE_NAMES.EXPIRY, {
  connection: getBullMQConnectionOptions(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
});
