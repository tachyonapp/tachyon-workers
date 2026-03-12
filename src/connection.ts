/**
 * This helper Returns a connection config object for use with BullMQ Queue and Worker constructors.
 * BullMQ creates and manages its own ioredis connections from this config,
 * applying maxRetriesPerRequest: null and enableReadyCheck: false automatically.
 *
 * Do NOT pass a shared ioredis instance — Workers require a blocking connection
 * incompatible with shared instances.
 *
 * NOTE: Return type is intentionally inferred rather than explicitly annotated as ConnectionOptions.
 * ConnectionOptions is a union (RedisOptions | ClusterOptions) — annotating with it widens
 * the type and prevents callers from accessing concrete properties (host, port, etc.).
 * The inferred object shape is structurally compatible with RedisOptions and satisfies
 * ConnectionOptions at BullMQ call sites via TypeScript's structural typing.
 */
export function getBullMQConnectionOptions() {
  return {
    host: process.env.VALKEY_HOST ?? "localhost",
    port: Number(process.env.VALKEY_PORT ?? 6379),
    password: process.env.VALKEY_PASSWORD || undefined,
    tls: process.env.VALKEY_TLS === "true" ? {} : undefined,
  };
}
