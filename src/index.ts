import { createHeartbeat, stopHeartbeat } from "./heartbeat";

const INSTANCE_ID = process.env.HOSTNAME || `worker-${process.pid}`;
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

async function main(): Promise<void> {
  console.log(`tachyon-workers starting (instance: ${INSTANCE_ID})`);

  const heartbeat = await createHeartbeat(INSTANCE_ID, HEARTBEAT_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    await stopHeartbeat(heartbeat);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(
    `Heartbeat active. Writing to Redis every ${HEARTBEAT_INTERVAL_MS / 1000}s`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
