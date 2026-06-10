import { Queue } from "bullmq";
import { QUEUE_NAMES } from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";

export const ruleResetQueue = new Queue(QUEUE_NAMES.RULE_RESET, {
  connection: getBullMQConnectionOptions(),
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
});
