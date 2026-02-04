import Redis from "ioredis";

export interface Heartbeat {
  interval: ReturnType<typeof setInterval>;
  redis: Redis;
  instanceId: string;
}

function createRedisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    lazyConnect: true,
  });
}

export async function createHeartbeat(
  instanceId: string,
  intervalMs: number
): Promise<Heartbeat> {
  const redis = createRedisClient();
  await redis.connect();

  // Write initial heartbeat
  const key = `worker:heartbeat:${instanceId}`;
  await redis.set(key, new Date().toISOString(), "EX", 90); // TTL 90s (3x interval)

  // Schedule recurring heartbeat
  const interval = setInterval(async () => {
    try {
      await redis.set(key, new Date().toISOString(), "EX", 90);
    } catch (err) {
      console.error("Heartbeat write failed:", err);
    }
  }, intervalMs);

  return { interval, redis, instanceId };
}

export async function stopHeartbeat(heartbeat: Heartbeat): Promise<void> {
  clearInterval(heartbeat.interval);
  const key = `worker:heartbeat:${heartbeat.instanceId}`;
  await heartbeat.redis.del(key);
  await heartbeat.redis.quit();
}
