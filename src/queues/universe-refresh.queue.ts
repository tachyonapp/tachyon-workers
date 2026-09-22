import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const universeRefreshQueue = new Queue(QUEUE_NAMES.UNIVERSE_REFRESH, {
  connection: getBullMQConnectionOptions(),
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
});
