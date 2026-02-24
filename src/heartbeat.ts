import { Redis as ValKey } from "ioredis";

export interface Heartbeat {
  interval: ReturnType<typeof setInterval>;
  valkey: ValKey;
  instanceId: string;
}

function createValkeyClient(): ValKey {
  return new ValKey({
    host: process.env.VALKEY_HOST || "localhost",
    port: parseInt(process.env.VALKEY_PORT || "6379", 10),
    password: process.env.VALKEY_PASSWORD || undefined,
    tls: process.env.VALKEY_TLS === "true" ? {} : undefined,
    lazyConnect: true,
  });
}

export async function createHeartbeat(
  instanceId: string,
  intervalMs: number,
): Promise<Heartbeat> {
  const valkey = createValkeyClient();
  await valkey.connect();

  // Write initial heartbeat
  const key = `worker:heartbeat:${instanceId}`;
  await valkey.set(key, new Date().toISOString(), "EX", 90); // TTL 90s (3x interval)

  // Schedule recurring heartbeat
  const interval = setInterval(async () => {
    try {
      await valkey.set(key, new Date().toISOString(), "EX", 90);
    } catch (err) {
      console.error("Heartbeat write failed:", err);
    }
  }, intervalMs);

  return { interval, valkey, instanceId };
}

export async function stopHeartbeat(heartbeat: Heartbeat): Promise<void> {
  clearInterval(heartbeat.interval);
  const key = `worker:heartbeat:${heartbeat.instanceId}`;
  await heartbeat.valkey.del(key);
  await heartbeat.valkey.quit();
}
