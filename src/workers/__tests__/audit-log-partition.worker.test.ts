// Prevent BullMQ Worker from opening Redis connections during unit tests
jest.mock("bullmq", () => ({
  Worker: jest
    .fn()
    .mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
  Queue: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@sentry/node", () => ({
  captureException: jest.fn(),
}));

jest.mock("../../db", () => ({ db: {} }));

// `sql` is used both as a tagged template (sql<T>`...`) and via sql.raw(...) —
// both return an object with .execute(db). We mock both call shapes and route
// tagged-template reads by inspecting the literal query text/bound values, and
// record every sql.raw() query string so tests can assert on exact DDL issued.
jest.mock("kysely", () => {
  const tag = jest.fn();
  const raw = jest.fn();
  Object.assign(tag, { raw });
  return { sql: tag };
});

import type { Job } from "bullmq";
import { sql } from "kysely";
import type { AuditLogPartitionJobPayload } from "@tachyonapp/tachyon-queue-types";
import { processAuditLogPartition } from "../audit-log-partition.worker";

const mockedSqlTag = sql as unknown as jest.Mock;
const mockedSqlRaw = (sql as unknown as { raw: jest.Mock }).raw;

// partitionsByPrefix simulates pre-existing partition tables returned by
// findAllPartitionTables for each table's prefix — set per-test.
let partitionsByPrefix: Record<string, string[]>;
let rawQueries: string[];

function resetSqlMocks(): void {
  partitionsByPrefix = {
    rule_audit_log_: [],
    scan_audit_log_: [],
  };
  rawQueries = [];

  mockedSqlRaw.mockReset();
  mockedSqlRaw.mockImplementation((query: string) => {
    rawQueries.push(query);
    return { execute: jest.fn().mockResolvedValue(undefined) };
  });

  mockedSqlTag.mockReset();
  mockedSqlTag.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("");

      if (text.includes("pg_inherits")) {
        // isAttached() — treat every existing partition as attached for these tests
        return {
          execute: jest.fn().mockResolvedValue({ rows: [{ found: true }] }),
        };
      }

      if (text.includes("AS partition_name")) {
        // findAllPartitionTables() — first bound value is `${partitionPrefix}%`
        const likePattern = values[0] as string;
        const prefix = likePattern.replace(/%$/, "");
        const names = partitionsByPrefix[prefix] ?? [];
        return {
          execute: jest
            .fn()
            .mockResolvedValue({
              rows: names.map((n) => ({ partition_name: n })),
            }),
        };
      }

      // tableExists() — always report "does not exist yet" so the create path runs
      return {
        execute: jest.fn().mockResolvedValue({ rows: [{ found: false }] }),
      };
    },
  );
}

function makeJob(triggeredAt: string): Job<AuditLogPartitionJobPayload> {
  return { data: { triggeredAt } } as Job<AuditLogPartitionJobPayload>;
}

describe("processAuditLogPartition", () => {
  beforeEach(() => {
    resetSqlMocks();
  });

  it("creates scan_audit_log's next-month partition without a REVOKE DELETE call, while rule_audit_log still gets one", async () => {
    await processAuditLogPartition(makeJob("2026-09-23T12:00:00.000Z"));

    const createdScan = rawQueries.find(
      (q) =>
        q.includes("CREATE TABLE IF NOT EXISTS scan_audit_log_2026_10") &&
        q.includes("PARTITION OF scan_audit_log"),
    );
    expect(createdScan).toBeDefined();

    const createdRule = rawQueries.find(
      (q) =>
        q.includes("CREATE TABLE IF NOT EXISTS rule_audit_log_2026_10") &&
        q.includes("PARTITION OF rule_audit_log"),
    );
    expect(createdRule).toBeDefined();

    const revokedRule = rawQueries.find(
      (q) =>
        q.includes("REVOKE DELETE") && q.includes("rule_audit_log_2026_10"),
    );
    expect(revokedRule).toBeDefined();

    const revokedScan = rawQueries.find(
      (q) => q.includes("REVOKE DELETE") && q.includes("scan_audit_log"),
    );
    expect(revokedScan).toBeUndefined();
  });

  it("detaches/drops scan_audit_log at 6/12 months, independent of rule_audit_log's 24/60-month cutoffs", async () => {
    // Relative to "now" = 2026-09-23:
    //   scan_audit_log: detach cutoff = 2026-03, drop cutoff = 2025-09
    //   rule_audit_log: detach cutoff = 2024-09, drop cutoff = 2021-09
    partitionsByPrefix["scan_audit_log_"] = [
      "scan_audit_log_2026_08", // 1 month old — untouched
      "scan_audit_log_2026_03", // exactly at 6-month detach cutoff — detach
      "scan_audit_log_2025_09", // exactly at 12-month drop cutoff — drop
    ];
    partitionsByPrefix["rule_audit_log_"] = [
      "rule_audit_log_2026_08", // recent — untouched
      "rule_audit_log_2024_09", // exactly at 24-month detach cutoff — detach
      "rule_audit_log_2021_09", // exactly at 60-month drop cutoff — drop
    ];

    await processAuditLogPartition(makeJob("2026-09-23T12:00:00.000Z"));

    expect(
      rawQueries.some(
        (q) => q === "DROP TABLE IF EXISTS scan_audit_log_2025_09",
      ),
    ).toBe(true);
    expect(
      rawQueries.some(
        (q) =>
          q ===
          "ALTER TABLE scan_audit_log DETACH PARTITION scan_audit_log_2026_03 CONCURRENTLY",
      ),
    ).toBe(true);
    expect(rawQueries.some((q) => q.includes("scan_audit_log_2026_08"))).toBe(
      false,
    );

    expect(
      rawQueries.some(
        (q) => q === "DROP TABLE IF EXISTS rule_audit_log_2021_09",
      ),
    ).toBe(true);
    expect(
      rawQueries.some(
        (q) =>
          q ===
          "ALTER TABLE rule_audit_log DETACH PARTITION rule_audit_log_2024_09 CONCURRENTLY",
      ),
    ).toBe(true);
    expect(rawQueries.some((q) => q.includes("rule_audit_log_2026_08"))).toBe(
      false,
    );

    // rule_audit_log's own cutoffs must not have shifted as a side effect of
    // generalizing the file for scan_audit_log.
    expect(
      rawQueries.some(
        (q) => q === "DROP TABLE IF EXISTS rule_audit_log_2024_09",
      ),
    ).toBe(false);
    expect(
      rawQueries.some(
        (q) =>
          q ===
          "ALTER TABLE rule_audit_log DETACH PARTITION rule_audit_log_2021_09 CONCURRENTLY",
      ),
    ).toBe(false);
  });
});
