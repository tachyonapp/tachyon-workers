/**
 * Graceful shutdown closes all Worker instances concurrently
 * and enforces a 30-second hard timeout.
 *
 * DigitalOcean App Platform sends `SIGTERM` and expects
 * the process to exit within 30 seconds before sending `SIGKILL`.
 *
 */

// Minimal interface — gracefulShutdown only calls close() on each worker.
// Using a structural interface instead of the concrete BullMQ Worker class
// keeps the signature testable without casting mocks to `any`.
interface Closeable {
  close(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function gracefulShutdown(
  workers: Closeable[],
  onTimeout?: () => void,
): Promise<void> {
  console.log(
    JSON.stringify({
      level: "info",
      event: "shutdown.initiated",
      workerCount: workers.length,
    }),
  );

  const timeoutHandle = setTimeout(() => {
    console.log(
      JSON.stringify({
        level: "warn",
        event: "shutdown.timeout",
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      }),
    );
    onTimeout?.();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await Promise.all(workers.map((w) => w.close()));
    clearTimeout(timeoutHandle);
    console.log(JSON.stringify({ level: "info", event: "shutdown.complete" }));
  } catch (err) {
    clearTimeout(timeoutHandle);
    console.error(
      JSON.stringify({
        level: "error",
        event: "shutdown.error",
        error: String(err),
      }),
    );
    process.exit(1);
  }
}
