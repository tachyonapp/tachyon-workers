import { Worker } from "bullmq";
import * as Sentry from "@sentry/node";
import { sql } from "kysely";
import {
  QUEUE_NAMES,
  type AuditLogPartitionJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { db } from "../db";

// Partition names are YYYY_MM-padded, e.g. rule_audit_log_2026_07
const PARTITION_PREFIX = "rule_audit_log_";
const PARTITION_NAME_RE = /^rule_audit_log_(\d{4})_(\d{2})$/;

function partitionName(year: number, month: number): string {
  return `${PARTITION_PREFIX}${year}_${String(month).padStart(2, "0")}`;
}

function parsePartitionName(name: string): { year: number; month: number } | null {
  const m = PARTITION_NAME_RE.exec(name);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

// Returns YYYYMM integer for month-granularity comparisons
function toYYYYMM(year: number, month: number): number {
  return year * 100 + month;
}

// Subtracts months from a date, returning the first of the resulting month (UTC)
function firstOfMonthMinusMonths(base: Date, months: number): Date {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - months, 1));
  return d;
}

// Returns the first of next month (UTC) relative to the given date
function firstOfNextMonth(base: Date): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
}

// ISO date string for use in SQL partition bounds, e.g. '2026-07-01'
function toISODateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Query all rule_audit_log partition tables (excluding the default partition).
// Includes both attached and detached partitions — we find them by name pattern
// in pg_class rather than via pg_inherits, so detached ones are also returned.
async function findAllPartitionTables(): Promise<string[]> {
  const result = await sql<{ partition_name: string }>`
    SELECT relname AS partition_name
    FROM pg_class
    WHERE relname LIKE ${"rule_audit_log_%"}
      AND relname != ${"rule_audit_log_default"}
      AND relkind = 'r'
    ORDER BY relname
  `.execute(db);
  return result.rows.map((r) => r.partition_name);
}

// Returns true if the named partition is currently attached to rule_audit_log
async function isAttached(name: string): Promise<boolean> {
  const result = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_inherits i
      JOIN pg_class child ON i.inhrelid  = child.oid
      JOIN pg_class parent ON i.inhparent = parent.oid
      WHERE parent.relname = 'rule_audit_log'
        AND child.relname  = ${name}
    ) AS found
  `.execute(db);
  return result.rows[0]?.found ?? false;
}

// Returns true if a table with the given name exists
async function tableExists(name: string): Promise<boolean> {
  const result = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = ${name} AND relkind = 'r'
    ) AS found
  `.execute(db);
  return result.rows[0]?.found ?? false;
}

export const auditLogPartitionWorker = new Worker<AuditLogPartitionJobPayload>(
  QUEUE_NAMES.AUDIT_LOG_PARTITION,
  async (job) => {
    const now = new Date(job.data.triggeredAt);

    const nextMonth = firstOfNextMonth(now);
    const nextYear = nextMonth.getUTCFullYear();
    const nextMonthNum = nextMonth.getUTCMonth() + 1;
    const nextName = partitionName(nextYear, nextMonthNum);

    // Month after next — upper bound of the new partition's range
    const monthAfterNext = firstOfNextMonth(nextMonth);

    // 24-month detach cutoff: detach any partition whose month is <= this YYYYMM
    const detachCutoff = firstOfMonthMinusMonths(now, 24);
    const detachCutoffYYYYMM = toYYYYMM(
      detachCutoff.getUTCFullYear(),
      detachCutoff.getUTCMonth() + 1,
    );

    // 60-month (5-year) drop cutoff: drop any partition whose month is <= this YYYYMM
    const dropCutoff = firstOfMonthMinusMonths(now, 60);
    const dropCutoffYYYYMM = toYYYYMM(
      dropCutoff.getUTCFullYear(),
      dropCutoff.getUTCMonth() + 1,
    );

    console.log(
      JSON.stringify({
        level: "info",
        event: "audit-log-partition.started",
        triggeredAt: job.data.triggeredAt,
        nextPartition: nextName,
        detachCutoffYYYYMM,
        dropCutoffYYYYMM,
      }),
    );

    // ── Step 1: Create next month's partition ───────────────────────────────
    const alreadyExists = await tableExists(nextName);
    if (!alreadyExists) {
      try {
        // Partition name is computed from date math — safe to use in sql.raw()
        await sql.raw(
          `CREATE TABLE IF NOT EXISTS ${nextName}` +
          ` PARTITION OF rule_audit_log` +
          ` FOR VALUES FROM ('${toISODateStr(nextMonth)}') TO ('${toISODateStr(monthAfterNext)}')`,
        ).execute(db);

        console.log(
          JSON.stringify({
            level: "info",
            event: "audit-log-partition.created",
            partition: nextName,
            from: toISODateStr(nextMonth),
            to: toISODateStr(monthAfterNext),
          }),
        );
      } catch (err) {
        Sentry.captureException(err, {
          extra: { step: "create", partition: nextName },
        });
        console.error(
          JSON.stringify({
            level: "error",
            event: "audit-log-partition.create-failed",
            partition: nextName,
            error: String(err),
          }),
        );
        throw err; // abort — REVOKE below requires the partition to exist
      }
    } else {
      console.log(
        JSON.stringify({
          level: "info",
          event: "audit-log-partition.already-exists",
          partition: nextName,
        }),
      );
    }

    // ── Step 2: REVOKE DELETE on new partition ──────────────────────────────
    // Idempotent — safe to run even if the partition already existed.
    // Compliance requirement: tachyon_app must never be able to delete audit rows.
    // Wrapped in a role-existence check so the cron does not fail in environments
    // where tachyon_app has not been provisioned (e.g. CI, local dev).
    try {
      await sql.raw(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tachyon_app') THEN REVOKE DELETE ON ${nextName} FROM tachyon_app; END IF; END $$`,
      ).execute(db);

      console.log(
        JSON.stringify({
          level: "info",
          event: "audit-log-partition.revoke-delete",
          partition: nextName,
        }),
      );
    } catch (err) {
      Sentry.captureException(err, {
        extra: { step: "revoke", partition: nextName },
      });
      console.error(
        JSON.stringify({
          level: "error",
          event: "audit-log-partition.revoke-failed",
          partition: nextName,
          error: String(err),
        }),
      );
      throw err;
    }

    // ── Steps 3–4: Process existing partitions (detach / drop) ─────────────
    const allPartitions = await findAllPartitionTables();

    for (const name of allPartitions) {
      const parsed = parsePartitionName(name);
      if (!parsed) continue;

      const yyyymm = toYYYYMM(parsed.year, parsed.month);

      if (yyyymm <= dropCutoffYYYYMM) {
        // 5-year retention window expired — drop permanently (GDPR/CCPA compliance)
        try {
          await sql.raw(`DROP TABLE IF EXISTS ${name}`).execute(db);
          console.log(
            JSON.stringify({
              level: "info",
              event: "audit-log-partition.dropped",
              partition: name,
              reason: "5-year retention window expired",
            }),
          );
        } catch (err) {
          Sentry.captureException(err, {
            extra: { step: "drop", partition: name },
          });
          console.error(
            JSON.stringify({
              level: "error",
              event: "audit-log-partition.drop-failed",
              partition: name,
              error: String(err),
            }),
          );
          // Non-fatal: log and continue — failure for one partition should not abort others
        }
      } else if (yyyymm <= detachCutoffYYYYMM) {
        // 24-month active window expired — detach (moves partition out of hot query path)
        // DETACH PARTITION CONCURRENTLY must run outside a transaction block.
        const attached = await isAttached(name);
        if (!attached) {
          console.log(
            JSON.stringify({
              level: "info",
              event: "audit-log-partition.already-detached",
              partition: name,
            }),
          );
          continue;
        }

        try {
          await sql.raw(
            `ALTER TABLE rule_audit_log DETACH PARTITION ${name} CONCURRENTLY`,
          ).execute(db);
          console.log(
            JSON.stringify({
              level: "info",
              event: "audit-log-partition.detached",
              partition: name,
              reason: "24-month active window expired",
            }),
          );
        } catch (err) {
          Sentry.captureException(err, {
            extra: { step: "detach", partition: name },
          });
          console.error(
            JSON.stringify({
              level: "error",
              event: "audit-log-partition.detach-failed",
              partition: name,
              error: String(err),
            }),
          );
          // Non-fatal: detach can fail transiently under concurrent load; BullMQ will retry
        }
      }
    }

    console.log(
      JSON.stringify({
        level: "info",
        event: "audit-log-partition.completed",
        triggeredAt: job.data.triggeredAt,
      }),
    );
  },
  {
    connection: getBullMQConnectionOptions(),
    concurrency: 1, // Partition DDL is sequential by nature
  },
);

auditLogPartitionWorker.on("failed", (job, err) => {
  Sentry.captureException(err, { extra: { jobId: job?.id } });
  console.error(
    JSON.stringify({
      level: "error",
      event: "audit-log-partition.job-failed",
      error: String(err),
    }),
  );
});
