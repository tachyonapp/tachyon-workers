// Prevent BullMQ Worker from opening Redis connections during unit tests
jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
  Queue: jest.fn().mockImplementation(() => ({})),
}));

import { processRuleReset } from "../rule-reset.worker";
import type { Job } from "bullmq";
import type { RuleResetJobPayload } from "@tachyonapp/tachyon-queue-types";

// ---------------------------------------------------------------------------
// Mock type definitions
// ---------------------------------------------------------------------------

interface SelectBuilderMock {
  select: jest.Mock;
  where: jest.Mock;
  executeTakeFirst: jest.Mock;
  execute: jest.Mock;
}

interface UpdateBuilderMock {
  set: jest.Mock;
  where: jest.Mock;
  execute: jest.Mock;
}

interface InsertBuilderMock {
  values: jest.Mock;
  execute: jest.Mock;
}

interface TxMock {
  selectFrom: jest.Mock;
  updateTable: jest.Mock;
  insertInto: jest.Mock;
}

interface DbMockState {
  tx: TxMock;
  txExecute: jest.Mock;
  transaction: jest.Mock;
  selectBuilder: SelectBuilderMock;
  updateBuilder: UpdateBuilderMock;
  insertBuilder: InsertBuilderMock;
}

interface DbModule {
  db: { transaction: jest.Mock; selectFrom: jest.Mock };
  __mock: DbMockState;
}

jest.mock("@sentry/node", () => ({
  captureException: jest.fn(),
}));

// ---------------------------------------------------------------------------
// DB Mock
// ---------------------------------------------------------------------------

jest.mock("../../db", () => {
  const selectBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    executeTakeFirst: jest.fn(),
    execute: jest.fn().mockResolvedValue([]),
  };

  const updateBuilder = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue([]),
  };

  const insertBuilder = {
    values: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue([]),
  };

  const tx = {
    selectFrom: jest.fn().mockReturnValue(selectBuilder),
    updateTable: jest.fn().mockReturnValue(updateBuilder),
    insertInto: jest.fn().mockReturnValue(insertBuilder),
  };

  const txExecute = jest
    .fn()
    .mockImplementation(
      async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    );
  const transaction = jest.fn().mockReturnValue({ execute: txExecute });

  const db = {
    transaction,
    selectFrom: jest.fn().mockReturnValue(selectBuilder),
  };

  return {
    db,
    __mock: { tx, txExecute, transaction, selectBuilder, updateBuilder, insertBuilder },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMocks() {
  const mod = jest.requireMock("../../db") as DbModule;
  return { db: mod.db, m: mod.__mock };
}

function makeJob(triggeredAt = new Date().toISOString()): Job<RuleResetJobPayload> {
  return { data: { triggeredAt } } as Job<RuleResetJobPayload>;
}

function resetBuilderMocks() {
  const { m, db } = getMocks();

  m.selectBuilder.select.mockReturnThis();
  m.selectBuilder.where.mockReturnThis();
  m.selectBuilder.execute.mockResolvedValue([]);
  m.selectBuilder.executeTakeFirst.mockResolvedValue(undefined);

  m.updateBuilder.set.mockReturnThis();
  m.updateBuilder.where.mockReturnThis();
  m.updateBuilder.execute.mockResolvedValue([]);

  m.insertBuilder.values.mockReturnThis();
  m.insertBuilder.execute.mockResolvedValue([]);

  m.tx.selectFrom.mockReturnValue(m.selectBuilder);
  m.tx.updateTable.mockReturnValue(m.updateBuilder);
  m.tx.insertInto.mockReturnValue(m.insertBuilder);

  m.txExecute.mockImplementation(
    async (cb: (t: TxMock) => Promise<unknown>) => cb(m.tx),
  );
  m.transaction.mockReturnValue({ execute: m.txExecute });
  db.transaction.mockReturnValue({ execute: m.txExecute });
  db.selectFrom.mockReturnValue(m.selectBuilder);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.resetAllMocks();
  resetBuilderMocks();
});

// ---------------------------------------------------------------------------
// Test 1: NORMAL reset
// ---------------------------------------------------------------------------

describe("processRuleReset — NORMAL recovery mode", () => {
  it("sets status ACTIVE and clears both recovery fields", async () => {
    const { db, m } = getMocks();

    // Outer selectFrom returns the stood-down bot
    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "1",
          user_id: "1",
          recovery_mode_applied: "NORMAL",
          recovery_mode_active_until: null,
        },
      ]),
    });

    // tx selects: runtime_data (no MAX_DRAWDOWN), no open position check (skipped for NORMAL)
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce({ standdown_reason: "DAILY_MAX_LOSS_REACHED" }) // runtime_data
      // no open position query follows for non-drawdown bots
      ;

    await processRuleReset(makeJob());

    // bots updated to ACTIVE with null recovery fields
    expect(m.tx.updateTable).toHaveBeenCalledWith("bots");
    const setCall = m.updateBuilder.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall?.status).toBe("ACTIVE");
    expect(setCall?.recovery_mode_applied).toBeNull();
    expect(setCall?.recovery_mode_active_until).toBeNull();

    // audit log written inside the transaction
    expect(m.tx.insertInto).toHaveBeenCalledWith("rule_audit_log");
    const auditValues = m.insertBuilder.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditValues?.evaluation_type).toBe("standdown_reset");
    expect(auditValues?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: MORE_CONSERVATIVE_2D reset
// ---------------------------------------------------------------------------

describe("processRuleReset — MORE_CONSERVATIVE_2D recovery mode", () => {
  it("sets status ACTIVE, preserves recovery mode, sets active_until = now + 2 days", async () => {
    const { db, m } = getMocks();

    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "2",
          user_id: "2",
          recovery_mode_applied: "MORE_CONSERVATIVE_2D",
          recovery_mode_active_until: null,
        },
      ]),
    });

    m.selectBuilder.executeTakeFirst.mockResolvedValueOnce({
      standdown_reason: "DAILY_MAX_LOSS_REACHED",
    });

    const before = Date.now();
    await processRuleReset(makeJob());

    expect(m.tx.updateTable).toHaveBeenCalledWith("bots");
    const setCall = m.updateBuilder.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall?.status).toBe("ACTIVE");
    expect(setCall?.recovery_mode_applied).toBe("MORE_CONSERVATIVE_2D");

    // recovery_mode_active_until should be ~2 days from now
    const until = setCall?.recovery_mode_active_until as Date;
    expect(until).toBeInstanceOf(Date);
    const diffDays = (until.getTime() - before) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(1.9);
    expect(diffDays).toBeLessThanOrEqual(2.1);

    // audit log written
    const auditValues = m.insertBuilder.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditValues?.evaluation_type).toBe("standdown_reset");
    const snapshot = JSON.parse(auditValues?.input_snapshot as string);
    expect(snapshot.recoveryMode).toBe("MORE_CONSERVATIVE_2D");
    expect(snapshot.newStatus).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Test 3: STAND_DOWN_1W — first cron run (no recovery_until yet)
// ---------------------------------------------------------------------------

describe("processRuleReset — STAND_DOWN_1W first cron run", () => {
  it("keeps bot STOOD_DOWN and sets recovery_mode_active_until = now + 7 days", async () => {
    const { db, m } = getMocks();

    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "3",
          user_id: "3",
          recovery_mode_applied: "STAND_DOWN_1W",
          recovery_mode_active_until: null,
        },
      ]),
    });

    m.selectBuilder.executeTakeFirst.mockResolvedValueOnce({
      standdown_reason: "DAILY_MAX_LOSS_REACHED",
    });

    const before = Date.now();
    await processRuleReset(makeJob());

    const setCall = m.updateBuilder.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall?.status).toBe("STOOD_DOWN");
    expect(setCall?.recovery_mode_applied).toBe("STAND_DOWN_1W");

    const until = setCall?.recovery_mode_active_until as Date;
    expect(until).toBeInstanceOf(Date);
    const diffDays = (until.getTime() - before) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });
});

// ---------------------------------------------------------------------------
// Test 4: STAND_DOWN_1W — 7-day window has elapsed → reset to ACTIVE
// ---------------------------------------------------------------------------

describe("processRuleReset — STAND_DOWN_1W after window elapsed", () => {
  it("resets bot to ACTIVE when recovery_mode_active_until is in the past", async () => {
    const { db, m } = getMocks();

    const pastDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "4",
          user_id: "4",
          recovery_mode_applied: "STAND_DOWN_1W",
          recovery_mode_active_until: pastDate,
        },
      ]),
    });

    m.selectBuilder.executeTakeFirst.mockResolvedValueOnce({
      standdown_reason: "DAILY_MAX_LOSS_REACHED",
    });

    await processRuleReset(makeJob());

    const setCall = m.updateBuilder.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall?.status).toBe("ACTIVE");
    expect(setCall?.recovery_mode_applied).toBeNull();
    expect(setCall?.recovery_mode_active_until).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 5: MAX_DRAWDOWN_EXCEEDED — open position exists → skipped
// ---------------------------------------------------------------------------

describe("processRuleReset — MAX_DRAWDOWN_EXCEEDED with open position", () => {
  it("skips the bot: no bots UPDATE, no rule_audit_log insert", async () => {
    const { db, m } = getMocks();

    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "5",
          user_id: "5",
          recovery_mode_applied: null,
          recovery_mode_active_until: null,
        },
      ]),
    });

    // runtime_data: standdown_reason = MAX_DRAWDOWN_EXCEEDED
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce({ standdown_reason: "MAX_DRAWDOWN_EXCEEDED" })
      // open position exists
      .mockResolvedValueOnce({ id: "pos-42" });

    await processRuleReset(makeJob());

    // no bots update should have been written
    expect(m.tx.updateTable).not.toHaveBeenCalledWith("bots");
    // no audit log written for the skipped bot
    expect(m.tx.insertInto).not.toHaveBeenCalledWith("rule_audit_log");
  });
});

// ---------------------------------------------------------------------------
// Test 6: MAX_DRAWDOWN_EXCEEDED — position closed → reset normally
// ---------------------------------------------------------------------------

describe("processRuleReset — MAX_DRAWDOWN_EXCEEDED with no open position", () => {
  it("resets bot normally (recovery_mode_applied = null → ACTIVE, null recovery fields)", async () => {
    const { db, m } = getMocks();

    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "6",
          user_id: "6",
          recovery_mode_applied: null,
          recovery_mode_active_until: null,
        },
      ]),
    });

    // runtime_data: MAX_DRAWDOWN_EXCEEDED, but no open position
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce({ standdown_reason: "MAX_DRAWDOWN_EXCEEDED" })
      .mockResolvedValueOnce(null); // no open position

    await processRuleReset(makeJob());

    const setCall = m.updateBuilder.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCall?.status).toBe("ACTIVE");
    expect(setCall?.recovery_mode_applied).toBeNull();
    expect(setCall?.recovery_mode_active_until).toBeNull();

    // audit log IS written (this bot was processed, not skipped)
    expect(m.tx.insertInto).toHaveBeenCalledWith("rule_audit_log");
  });
});

// ---------------------------------------------------------------------------
// Test 7: One bot failure does not abort the batch
// ---------------------------------------------------------------------------

describe("processRuleReset — one bot failure does not abort the batch", () => {
  it("continues processing subsequent bots when one transaction throws", async () => {
    const { db, m } = getMocks();

    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "10",
          user_id: "10",
          recovery_mode_applied: "NORMAL",
          recovery_mode_active_until: null,
        },
        {
          id: "11",
          user_id: "11",
          recovery_mode_applied: "NORMAL",
          recovery_mode_active_until: null,
        },
      ]),
    });

    let callCount = 0;
    m.txExecute.mockImplementation(
      async (cb: (t: TxMock) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) throw new Error("DB timeout on bot 10");
        return cb(m.tx);
      },
    );
    db.transaction.mockReturnValue({ execute: m.txExecute });

    // runtime_data for bot 11 (bot 10 throws before reading it)
    m.selectBuilder.executeTakeFirst.mockResolvedValue({
      standdown_reason: "DAILY_MAX_LOSS_REACHED",
    });

    await processRuleReset(makeJob());

    // Second bot still processed: tx was entered twice
    expect(m.txExecute).toHaveBeenCalledTimes(2);
    // Second bot's bots update was called
    expect(m.tx.updateTable).toHaveBeenCalledWith("bots");
  });
});

// ---------------------------------------------------------------------------
// Test 8: audit_log entry always inside the transaction
// ---------------------------------------------------------------------------

describe("processRuleReset — rule_audit_log written inside transaction", () => {
  it("uses tx.insertInto for the audit log (not db.insertInto)", async () => {
    const { db, m } = getMocks();

    db.selectFrom.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue([
        {
          id: "20",
          user_id: "20",
          recovery_mode_applied: "NORMAL",
          recovery_mode_active_until: null,
        },
      ]),
    });

    m.selectBuilder.executeTakeFirst.mockResolvedValueOnce({
      standdown_reason: "DAILY_MAX_GAIN_REACHED",
    });

    await processRuleReset(makeJob());

    // audit log must be written via tx, not the outer db
    expect(m.tx.insertInto).toHaveBeenCalledWith("rule_audit_log");
  });
});
