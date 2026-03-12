import { scanDispatchQueue } from "./scan-dispatch.queue";
import { scanBotQueue } from "./scan-bot.queue";
import { expiryQueue } from "./expiry.queue";
import { reconciliationQueue } from "./reconciliation.queue";
import { notificationQueue } from "./notification.queue";
import { summaryQueue } from "./summary.queue";

// Named exports — for callers that need a specific queue by name
// (e.g. scheduler.ts registering crons, scan-dispatch.worker.ts fanning out to scan-bot)
export { scanDispatchQueue } from "./scan-dispatch.queue";
export { scanBotQueue } from "./scan-bot.queue";
export { expiryQueue } from "./expiry.queue";
export { reconciliationQueue } from "./reconciliation.queue";
export { notificationQueue } from "./notification.queue";
export { summaryQueue } from "./summary.queue";

// Array export — for callers that need to iterate over all queues without caring which is which
// (e.g. queue-clean.ts flushing all queues, Bull Board dashboard registering all adapters)
export const allQueues = [
  scanDispatchQueue,
  scanBotQueue,
  expiryQueue,
  reconciliationQueue,
  notificationQueue,
  summaryQueue,
] as const;
