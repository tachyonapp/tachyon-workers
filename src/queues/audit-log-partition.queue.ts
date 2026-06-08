import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const auditLogPartitionQueue = new Queue(QUEUE_NAMES.AUDIT_LOG_PARTITION, {
  connection: getBullMQConnectionOptions(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});
