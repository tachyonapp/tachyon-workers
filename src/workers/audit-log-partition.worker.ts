import { Worker, type Job } from "bullmq";
import * as Sentry from "@sentry/node";
import { sql } from "kysely";
import {
  QUEUE_NAMES,
  type AuditLogPartitionJobPayload,
} from "@tachyonapp/tachyon-queue-types";
import { getBullMQConnectionOptions } from "../connection";
import { db } from "../db";

interface AuditPartitionTableConfig {
  tableName: string;
  partitionPrefix: string;
  partitionNameRe: RegExp;
  detachMonths: number;
  dropMonths: number;
  // Whether newly-created partitions get `REVOKE DELETE ... FROM tachyon_app`.
  // rule_audit_log: yes (GDPR/CCPA-mandated immutability). scan_audit_log: no
  // (operational telemetry, no legal retention mandate — see migration 016 in tachyon-db).
  revokeDelete: boolean;
}

const RULE_AUDIT_LOG_CONFIG: AuditPartitionTableConfig = {
  tableName: "rule_audit_log",
  partitionPrefix: "rule_audit_log_",
  partitionNameRe: /^rule_audit_log_(\d{4})_(\d{2})$/,
  detachMonths: 24,
  dropMonths: 60,
  revokeDelete: true,
};

// Placeholder retention window — pending final confirmation.
// Trivially adjustable constants, not magic numbers scattered through
// the file.
const SCAN_AUDIT_DETACH_MONTHS = 6;
const SCAN_AUDIT_DROP_MONTHS = 12;

const SCAN_AUDIT_LOG_CONFIG: AuditPartitionTableConfig = {
  tableName: "scan_audit_log",
  partitionPrefix: "scan_audit_log_",
  partitionNameRe: /^scan_audit_log_(\d{4})_(\d{2})$/,
  detachMonths: SCAN_AUDIT_DETACH_MONTHS,
  dropMonths: SCAN_AUDIT_DROP_MONTHS,
  revokeDelete: false,
};

function partitionName(
  config: AuditPartitionTableConfig,
  year: number,
  month: number,
): string {
  return `${config.partitionPrefix}${year}_${String(month).padStart(2, "0")}`;
}

function parsePartitionName(
  config: AuditPartitionTableConfig,
  name: string,
): { year: number; month: number } | null {
  const m = config.partitionNameRe.exec(name);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

// Returns YYYYMM integer for month-granularity comparisons
function toYYYYMM(year: number, month: number): number {
  return year * 100 + month;
}

// Subtracts months from a date, returning the first of the resulting month (UTC)
function firstOfMonthMinusMonths(base: Date, months: number): Date {
  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - months, 1),
  );
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

// Query all of a table's partition tables (excluding its default partition).
// Includes both attached and detached partitions — we find them by name pattern
// in pg_class rather than via pg_inherits, so detached ones are also returned.
async function findAllPartitionTables(
  config: AuditPartitionTableConfig,
): Promise<string[]> {
  const result = await sql<{ partition_name: string }>`
    SELECT relname AS partition_name
    FROM pg_class
    WHERE relname LIKE ${`${config.partitionPrefix}%`}
      AND relname != ${`${config.tableName}_default`}
      AND relkind = 'r'
    ORDER BY relname
  `.execute(db);
  return result.rows.map((r) => r.partition_name);
}

// Returns true if the named partition is currently attached to the given table
async function isAttached(
  config: AuditPartitionTableConfig,
  name: string,
): Promise<boolean> {
  const result = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_inherits i
      JOIN pg_class child ON i.inhrelid  = child.oid
      JOIN pg_class parent ON i.inhparent = parent.oid
      WHERE parent.relname = ${config.tableName}
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

// Runs the full create/revoke/detach/drop lifecycle for one partitioned audit
// table. Called once per table per job execution so a single cron continues to
// manage both rule_audit_log and scan_audit_log rather than standing up a
// second Worker/cron registration.
async function processTablePartitions(
  config: AuditPartitionTableConfig,
  now: Date,
  triggeredAt: string,
): Promise<void> {
  const nextMonth = firstOfNextMonth(now);
  const nextYear = nextMonth.getUTCFullYear();
  const nextMonthNum = nextMonth.getUTCMonth() + 1;
  const nextName = partitionName(config, nextYear, nextMonthNum);

  // Month after next — upper bound of the new partition's range
  const monthAfterNext = firstOfNextMonth(nextMonth);

  const detachCutoff = firstOfMonthMinusMonths(now, config.detachMonths);
  const detachCutoffYYYYMM = toYYYYMM(
    detachCutoff.getUTCFullYear(),
    detachCutoff.getUTCMonth() + 1,
  );

  const dropCutoff = firstOfMonthMinusMonths(now, config.dropMonths);
  const dropCutoffYYYYMM = toYYYYMM(
    dropCutoff.getUTCFullYear(),
    dropCutoff.getUTCMonth() + 1,
  );

  console.log(
    JSON.stringify({
      level: "info",
      event: "audit-log-partition.started",
      table: config.tableName,
      triggeredAt,
      nextPartition: nextName,
      detachCutoffYYYYMM,
      dropCutoffYYYYMM,
    }),
  );

  // ── Step 1: Create next month's partition ───────────────────────────────
  const alreadyExists = await tableExists(nextName);
  if (!alreadyExists) {
    try {
      // Partition/table names here are computed from date math and the fixed
      // config above — never from user input — safe to use in sql.raw().
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS ${nextName}` +
            ` PARTITION OF ${config.tableName}` +
            ` FOR VALUES FROM ('${toISODateStr(nextMonth)}') TO ('${toISODateStr(monthAfterNext)}')`,
        )
        .execute(db);

      console.log(
        JSON.stringify({
          level: "info",
          event: "audit-log-partition.created",
          table: config.tableName,
          partition: nextName,
          from: toISODateStr(nextMonth),
          to: toISODateStr(monthAfterNext),
        }),
      );
    } catch (err) {
      Sentry.captureException(err, {
        extra: { step: "create", table: config.tableName, partition: nextName },
      });
      console.error(
        JSON.stringify({
          level: "error",
          event: "audit-log-partition.create-failed",
          table: config.tableName,
          partition: nextName,
          error: String(err),
        }),
      );
      throw err; // abort — REVOKE below (when applicable) requires the partition to exist
    }
  } else {
    console.log(
      JSON.stringify({
        level: "info",
        event: "audit-log-partition.already-exists",
        table: config.tableName,
        partition: nextName,
      }),
    );
  }

  // ── Step 2: REVOKE DELETE on new partition (rule_audit_log only) ────────
  // Idempotent — safe to run even if the partition already existed.
  // Compliance requirement: app must never be able to delete rule_audit_log
  // rows. scan_audit_log is deliberately NOT revoked (operational telemetry, no
  // GDPR/CCPA retention mandate) — do not move this call outside the `if` below,
  // that would silently restrict scan_audit_log too.
  if (config.revokeDelete) {
    try {
      await sql
        .raw(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tachyon_app') THEN REVOKE DELETE ON ${nextName} FROM tachyon_app; END IF; END $$`,
        )
        .execute(db);

      console.log(
        JSON.stringify({
          level: "info",
          event: "audit-log-partition.revoke-delete",
          table: config.tableName,
          partition: nextName,
        }),
      );
    } catch (err) {
      Sentry.captureException(err, {
        extra: { step: "revoke", table: config.tableName, partition: nextName },
      });
      console.error(
        JSON.stringify({
          level: "error",
          event: "audit-log-partition.revoke-failed",
          table: config.tableName,
          partition: nextName,
          error: String(err),
        }),
      );
      throw err;
    }
  }

  // ── Steps 3–4: Process existing partitions (detach / drop) ─────────────
  const allPartitions = await findAllPartitionTables(config);

  for (const name of allPartitions) {
    const parsed = parsePartitionName(config, name);
    if (!parsed) continue;

    const yyyymm = toYYYYMM(parsed.year, parsed.month);

    if (yyyymm <= dropCutoffYYYYMM) {
      // Retention window expired — drop permanently
      try {
        await sql.raw(`DROP TABLE IF EXISTS ${name}`).execute(db);
        console.log(
          JSON.stringify({
            level: "info",
            event: "audit-log-partition.dropped",
            table: config.tableName,
            partition: name,
            reason: `${config.dropMonths}-month retention window expired`,
          }),
        );
      } catch (err) {
        Sentry.captureException(err, {
          extra: { step: "drop", table: config.tableName, partition: name },
        });
        console.error(
          JSON.stringify({
            level: "error",
            event: "audit-log-partition.drop-failed",
            table: config.tableName,
            partition: name,
            error: String(err),
          }),
        );
        // Non-fatal: log and continue — failure for one partition should not abort others
      }
    } else if (yyyymm <= detachCutoffYYYYMM) {
      // Active window expired — detach (moves partition out of hot query path)
      // DETACH PARTITION CONCURRENTLY must run outside a transaction block.
      const attached = await isAttached(config, name);
      if (!attached) {
        console.log(
          JSON.stringify({
            level: "info",
            event: "audit-log-partition.already-detached",
            table: config.tableName,
            partition: name,
          }),
        );
        continue;
      }

      try {
        await sql
          .raw(
            `ALTER TABLE ${config.tableName} DETACH PARTITION ${name} CONCURRENTLY`,
          )
          .execute(db);
        console.log(
          JSON.stringify({
            level: "info",
            event: "audit-log-partition.detached",
            table: config.tableName,
            partition: name,
            reason: `${config.detachMonths}-month active window expired`,
          }),
        );
      } catch (err) {
        Sentry.captureException(err, {
          extra: { step: "detach", table: config.tableName, partition: name },
        });
        console.error(
          JSON.stringify({
            level: "error",
            event: "audit-log-partition.detach-failed",
            table: config.tableName,
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
      table: config.tableName,
      triggeredAt,
    }),
  );
}

export async function processAuditLogPartition(
  job: Job<AuditLogPartitionJobPayload>,
): Promise<void> {
  const now = new Date(job.data.triggeredAt);

  await processTablePartitions(
    RULE_AUDIT_LOG_CONFIG,
    now,
    job.data.triggeredAt,
  );
  await processTablePartitions(
    SCAN_AUDIT_LOG_CONFIG,
    now,
    job.data.triggeredAt,
  );
}

export const auditLogPartitionWorker = new Worker<AuditLogPartitionJobPayload>(
  QUEUE_NAMES.AUDIT_LOG_PARTITION,
  processAuditLogPartition,
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
