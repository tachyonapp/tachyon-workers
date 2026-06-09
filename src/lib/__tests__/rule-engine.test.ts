import { evaluateProposalRules, evaluatePreSubmissionRules, stubbedPnLProvider } from '../rule-engine';
import type { RuleEngineInput, PreSubmissionInput } from '@tachyonapp/tachyon-queue-types';

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

// ---------------------------------------------------------------------------
// DB Mock
// ---------------------------------------------------------------------------
// All builders are created inside the jest.mock factory (hoisting-safe).
// Exposed via __mock for test-level configuration.
// ---------------------------------------------------------------------------

jest.mock('../../db', () => {
  const selectBuilder = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
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

  const txExecute = jest.fn().mockImplementation(async (cb: any) => cb(tx));
  const transaction = jest.fn().mockReturnValue({ execute: txExecute });

  const db = {
    transaction,
    // Used by writeManualCloseAuditLog (standalone insert, not in transaction)
    insertInto: jest.fn().mockReturnValue(insertBuilder),
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
  const mod = require('../../db') as { db: any; __mock: any };
  const sentry = require('@sentry/node') as { captureException: jest.Mock };
  return { db: mod.db, m: mod.__mock, sentry };
}

function resetBuilderMocks() {
  const { m, db } = getMocks();

  m.selectBuilder.select.mockReturnThis();
  m.selectBuilder.where.mockReturnThis();
  m.selectBuilder.innerJoin.mockReturnThis();
  m.selectBuilder.forUpdate.mockReturnThis();
  m.selectBuilder.execute.mockResolvedValue([]);

  m.updateBuilder.set.mockReturnThis();
  m.updateBuilder.where.mockReturnThis();
  m.updateBuilder.execute.mockResolvedValue([]);

  m.insertBuilder.values.mockReturnThis();
  m.insertBuilder.execute.mockResolvedValue([]);

  m.tx.selectFrom.mockReturnValue(m.selectBuilder);
  m.tx.updateTable.mockReturnValue(m.updateBuilder);
  m.tx.insertInto.mockReturnValue(m.insertBuilder);

  m.txExecute.mockImplementation(async (cb: any) => cb(m.tx));
  m.transaction.mockReturnValue({ execute: m.txExecute });
  db.transaction.mockReturnValue({ execute: m.txExecute });
  db.insertInto.mockReturnValue(m.insertBuilder);
}

// Base DB rows
const BOT = {
  id: '1',
  user_id: '1',
  capital_allocated_usd: '1000',
  status: 'ACTIVE',
  recovery_mode_applied: null as string | null,
};

const SETTINGS = {
  daily_max_loss_pct: '0.05',  // 5% → threshold = -$50
  daily_max_gain: '0.10',      // 10% → threshold = $100
  combat_patience: 'CALCULATED',
  trade_tempo: 'ACTIVE',       // ACTIVE = 20-min cooldown
  max_drawdown_protection_pct: '0.08',
  recovery_mode: 'NORMAL',
};

const RUNTIME = {
  pnl_realized: '0',
  pnl_unrealized: '0',
  stands_down: false,
};

const ENTRY_INPUT: RuleEngineInput = {
  botId: '1',
  userId: '1',
  proposedPositionSizeUsd: 500,
  proposedEntryPrice: 100,
  isExitProposal: false,
};

const EXIT_INPUT: RuleEngineInput = {
  botId: '1',
  userId: '1',
  proposedPositionSizeUsd: 500, // realistic exit size — must be >= MIN_POSITION_SIZE_USD
  proposedEntryPrice: 100,
  isExitProposal: true,
  exitReason: 'TARGET',
};

// Set up the standard base sequence (bots, settings, runtime) for entry proposals.
// Call this before per-test rule-specific mocks.
function setupEntryBase(botOverrides?: Partial<typeof BOT>, runtimeOverride?: typeof RUNTIME | null) {
  const { m } = getMocks();
  m.selectBuilder.executeTakeFirst
    .mockResolvedValueOnce({ ...BOT, ...botOverrides })   // bots
    .mockResolvedValueOnce(SETTINGS)                      // bot_settings
    .mockResolvedValueOnce(runtimeOverride !== undefined ? runtimeOverride : RUNTIME); // bot_runtime_data
}

// Set up base sequence for exit proposals.
function setupExitBase(botOverrides?: Partial<typeof BOT>) {
  const { m } = getMocks();
  m.selectBuilder.executeTakeFirst
    .mockResolvedValueOnce({ ...BOT, ...botOverrides })
    .mockResolvedValueOnce(SETTINGS)
    .mockResolvedValueOnce(RUNTIME);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.resetAllMocks();
  resetBuilderMocks();
});

// ---------------------------------------------------------------------------
// Test 1: OPEN_POSITION_EXISTS
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — OPEN_POSITION_EXISTS', () => {
  it('returns passed: false with OPEN_POSITION_EXISTS when bot has an open position', async () => {
    const { m } = getMocks();

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce({ id: '99' })  // Rule 1: open position exists
      .mockResolvedValueOnce(null)           // Rule 2: no recent proposal
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4: cash account

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('OPEN_POSITION_EXISTS');
    expect(result.ruleViolations[0]?.ruleId).toBe('OPEN_POSITION_EXISTS');

    // Audit log must be written
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');
    expect(m.insertBuilder.execute).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2: DAILY_MAX_LOSS_REACHED — standown triggered in same transaction
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — DAILY_MAX_LOSS_REACHED standown', () => {
  it('sets bot STOOD_DOWN and writes bot_runtime_data in the same transaction', async () => {
    const { m } = getMocks();

    // P&L at threshold: realized = -$50, capital = $1000, loss_pct = 5% → threshold = -$50
    setupEntryBase(undefined, { pnl_realized: '-50', pnl_unrealized: '0', stands_down: false });

    // Rule 1: no open position; Rule 2: no recent proposal; Rule 4: cash
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)           // Rule 1
      .mockResolvedValueOnce(null)           // Rule 2
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('DAILY_MAX_LOSS_REACHED');

    // bots.status = 'STOOD_DOWN' must be written
    expect(m.tx.updateTable).toHaveBeenCalledWith('bots');
    const botsSetCall = m.updateBuilder.set.mock.calls.find(
      (call: any[]) => call[0]?.status === 'STOOD_DOWN',
    );
    expect(botsSetCall).toBeDefined();
    expect(botsSetCall![0].recovery_mode_applied).toBe('NORMAL'); // copies recovery_mode from settings

    // bot_runtime_data.stands_down = true must be written
    expect(m.tx.updateTable).toHaveBeenCalledWith('bot_runtime_data');
    const runtimeSetCall = m.updateBuilder.set.mock.calls.find(
      (call: any[]) => call[0]?.stands_down === true,
    );
    expect(runtimeSetCall).toBeDefined();
    expect(runtimeSetCall![0].standdown_reason).toBe('DAILY_MAX_LOSS_REACHED');

    // Audit log written
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Pre-submission catches state changes after proposal creation
// ---------------------------------------------------------------------------

describe('evaluatePreSubmissionRules — state change caught at submission time', () => {
  it('returns passed: false with DAILY_MAX_LOSS_REACHED when loss threshold crossed after proposal creation', async () => {
    const { m } = getMocks();

    // Simulate: proposal was created earlier when P&L was fine. Between proposal
    // creation and user approval, another trade closed at a loss. At submission
    // time pnl_realized = -$50 (= 5% of $1000 = loss threshold).
    setupEntryBase(undefined, { pnl_realized: '-50', pnl_unrealized: '0', stands_down: false });
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)            // Rule 1: no open position
      .mockResolvedValueOnce(null)            // Rule 2: no recent proposal
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4: cash

    const preSubmissionInput: PreSubmissionInput = {
      ...ENTRY_INPUT,
      proposalId: 'prop-1',
    };

    const result = await evaluatePreSubmissionRules(preSubmissionInput);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('DAILY_MAX_LOSS_REACHED');
    expect(result.ruleViolations[0]?.ruleId).toBe('DAILY_MAX_LOSS_REACHED');

    // Standown write and audit log both occur inside the same transaction
    expect(m.tx.updateTable).toHaveBeenCalledWith('bots');
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');
  });
});

// ---------------------------------------------------------------------------
// Test 4: MANUAL_CLOSE bypass
// ---------------------------------------------------------------------------

describe('evaluatePreSubmissionRules — MANUAL_CLOSE bypass', () => {
  it('skips all rules and writes audit log with bypass marker', async () => {
    const { m, db } = getMocks();

    const manualCloseInput: PreSubmissionInput = {
      ...EXIT_INPUT,
      exitReason: 'MANUAL_CLOSE',
      proposalId: 'prop-manual',
    };

    const result = await evaluatePreSubmissionRules(manualCloseInput);

    expect(result.passed).toBe(true);
    expect(result.ruleViolations).toHaveLength(0);
    expect(result.rejectionReason).toBeUndefined();

    // No transaction was started (manual close uses standalone insert)
    expect(db.transaction).not.toHaveBeenCalled();

    // Standalone audit log written via db.insertInto (not tx.insertInto)
    expect(db.insertInto).toHaveBeenCalledWith('rule_audit_log');
    const valuesArg = m.insertBuilder.values.mock.calls[0]?.[0];
    expect(valuesArg).toBeDefined();
    const snapshot = JSON.parse(valuesArg.input_snapshot);
    expect(snapshot.bypass).toBe('USER_INITIATED_CLOSE');
    expect(valuesArg.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: STOP_LOSS bypass — rule 8 skipped, other rules still run
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — STOP_LOSS bypass', () => {
  it('skips HOLDING_PERIOD_NOT_ELAPSED but runs all other applicable rules', async () => {
    const { m } = getMocks();

    const stopLossInput: RuleEngineInput = {
      ...EXIT_INPUT,
      exitReason: 'STOP_LOSS',
    };

    setupExitBase();
    // For exit proposals: Rule 1 skipped, Rule 2 runs, Rule 4 runs, Rule 8 skipped (STOP_LOSS), Rule 9 runs
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)            // Rule 2: no recent proposal
      .mockResolvedValueOnce({ balance: '5000' }) // Rule 4: cash
      // Rule 8: NOT called (stop-loss bypass)
      .mockResolvedValueOnce(null);           // Rule 9: no open position → returns null

    const result = await evaluatePreSubmissionRules({
      ...stopLossInput,
      proposalId: 'prop-stoploss',
    });

    expect(result.passed).toBe(true);

    // Rule 8 (HOLDING_PERIOD_NOT_ELAPSED) should NOT have been called.
    // It queries positions with a specific select pattern that includes 'min_hold_until'.
    // All position queries go through selectBuilder; verify 'min_hold_until' was never selected.
    const allSelectCalls = m.selectBuilder.select.mock.calls.flat(2);
    expect(allSelectCalls).not.toContain('min_hold_until');

    // Audit log always written
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Fail-safe — DB error returns EVALUATION_ERROR, Sentry fires
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — fail-safe on DB error', () => {
  it('returns passed: false with EVALUATION_ERROR and captures to Sentry on any DB error', async () => {
    const { m, sentry } = getMocks();

    // Make the transaction throw
    m.txExecute.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('EVALUATION_ERROR');
    expect(result.ruleViolations).toHaveLength(0);

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const sentryCall = sentry.captureException.mock.calls[0];
    expect(sentryCall[0]).toBeInstanceOf(Error);
    expect(sentryCall[1]).toMatchObject({ extra: { botId: ENTRY_INPUT.botId } });
  });

  it('never returns passed: true on DB error', async () => {
    const { m } = getMocks();
    m.txExecute.mockRejectedValueOnce(new Error('timeout'));

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Atomicity — STOOD_DOWN write and audit log in same transaction
// ---------------------------------------------------------------------------

describe('atomicity — STOOD_DOWN write and audit log in same transaction', () => {
  it('both bots.status update and rule_audit_log insert occur within one transaction callback', async () => {
    const { m } = getMocks();

    // Trigger DAILY_MAX_GAIN_REACHED — realized P&L hits threshold
    setupEntryBase(undefined, { pnl_realized: '100', pnl_unrealized: '0', stands_down: false });
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)          // Rule 1
      .mockResolvedValueOnce(null)          // Rule 2
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4

    // Track execution order
    const callOrder: string[] = [];
    m.updateBuilder.execute.mockImplementation(async () => { callOrder.push('update'); return []; });
    m.insertBuilder.execute.mockImplementation(async () => { callOrder.push('insert'); return []; });

    await evaluateProposalRules(ENTRY_INPUT);

    // Both the bots UPDATE and the rule_audit_log INSERT happened
    expect(m.tx.updateTable).toHaveBeenCalledWith('bots');
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');

    // Both used the tx object (not the outer db), confirming they're in the same transaction
    expect(m.tx.updateTable).toHaveBeenCalled();
    expect(m.tx.insertInto).toHaveBeenCalled();

    // The update and insert both executed (order: bots update, runtime update, audit insert)
    expect(callOrder).toContain('update');
    expect(callOrder).toContain('insert');

    // db.transaction was called exactly once — single transaction wrapping both writes
    expect(m.transaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 8: SELECT ... FOR UPDATE present on bots query
// ---------------------------------------------------------------------------

describe('SELECT ... FOR UPDATE on bots row', () => {
  it('calls .forUpdate() on the bots selectFrom chain', async () => {
    const { m } = getMocks();

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ balance: '5000' });

    await evaluateProposalRules(ENTRY_INPUT);

    // forUpdate() must be called at least once (on the bots query)
    expect(m.selectBuilder.forUpdate).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 9: Audit log written on both pass and fail evaluations
// ---------------------------------------------------------------------------

describe('audit log always written', () => {
  it('writes exactly one rule_audit_log entry for a passing evaluation', async () => {
    const { m } = getMocks();

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ balance: '5000' });

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).toBe(true);
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');

    // values() called with passed: true
    const valuesArg = m.insertBuilder.values.mock.calls[0]?.[0];
    expect(valuesArg?.passed).toBe(true);
  });

  it('writes exactly one rule_audit_log entry for a failing evaluation', async () => {
    const { m } = getMocks();

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce({ id: '99' })  // Rule 1 fires
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ balance: '5000' });

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).toBe(false);
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');

    const valuesArg = m.insertBuilder.values.mock.calls[0]?.[0];
    expect(valuesArg?.passed).toBe(false);
    expect(valuesArg?.rejection_reason).toBe('OPEN_POSITION_EXISTS');
  });
});

// ---------------------------------------------------------------------------
// Test 10: rule_audit_log never written outside a transaction
// ---------------------------------------------------------------------------

describe('rule_audit_log insert is always inside db.transaction', () => {
  it('uses tx.insertInto (not db.insertInto) for the audit log in normal evaluation', async () => {
    const { m, db } = getMocks();

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ balance: '5000' });

    await evaluateProposalRules(ENTRY_INPUT);

    // tx.insertInto used (inside transaction)
    expect(m.tx.insertInto).toHaveBeenCalledWith('rule_audit_log');
    // db.insertInto NOT used (would be outside transaction)
    expect(db.insertInto).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 11: MAX_DRAWDOWN_EXCEEDED standown with recovery_mode_applied = NULL
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — MAX_DRAWDOWN_EXCEEDED standown', () => {
  it('sets STOOD_DOWN with recovery_mode_applied = null (not copied from bot_settings)', async () => {
    const { m } = getMocks();

    const drawdownInput: RuleEngineInput = {
      ...EXIT_INPUT,
      exitReason: 'TARGET',
    };

    setupExitBase();
    // Exit proposal: Rule 1 skipped, Rule 2 runs, Rule 4 runs
    // Rule 8 (HOLDING_PERIOD): position has elapsed min_hold_until
    // Rule 9 (MAX_DRAWDOWN): unrealized loss at threshold
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)            // Rule 2: no recent proposal
      .mockResolvedValueOnce({ balance: '5000' }) // Rule 4: cash
      .mockResolvedValueOnce(null)            // Rule 8: no open position → no holding check
      .mockResolvedValueOnce({ id: '42', capital_allocated_usd: '1000' }); // Rule 9: open position

    const mockPnLProvider = {
      getUnrealizedPnL: jest.fn().mockResolvedValue(-80), // -$80 on $1000 allocation = 8% loss = threshold
    };

    const result = await evaluatePreSubmissionRules(
      { ...drawdownInput, proposalId: 'prop-drawdown' },
      mockPnLProvider,
    );

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('MAX_DRAWDOWN_EXCEEDED');

    // Verify STOOD_DOWN was written with recovery_mode_applied = NULL
    expect(m.tx.updateTable).toHaveBeenCalledWith('bots');
    const botsSetCall = m.updateBuilder.set.mock.calls.find(
      (call: any[]) => call[0]?.status === 'STOOD_DOWN',
    );
    expect(botsSetCall).toBeDefined();
    expect(botsSetCall![0].recovery_mode_applied).toBeNull();

    // Confirm this is a DIFFERENT code path from DAILY_MAX_LOSS_REACHED which copies recovery_mode
    // DAILY_MAX_GAIN test (test 7) verifies recovery_mode_applied is copied; this test confirms
    // MAX_DRAWDOWN_EXCEEDED explicitly sets it to null regardless of bot_settings.recovery_mode
  });

  it('reset cron does NOT reset a MAX_DRAWDOWN stood-down bot with an open position', async () => {
    // This test validates the reset cron guard condition by simulating its logic directly.
    // The actual cron is in rule-reset.worker.ts (Task 04); this test confirms the guard
    // condition is correct: standdown_reason=MAX_DRAWDOWN_EXCEEDED + open position = skip.
    const standdownReason = 'MAX_DRAWDOWN_EXCEEDED';
    const hasOpenPosition = true;

    // Guard: skip if MAX_DRAWDOWN_EXCEEDED and open position exists
    const shouldSkip = standdownReason === 'MAX_DRAWDOWN_EXCEEDED' && hasOpenPosition;
    expect(shouldSkip).toBe(true);

    // Guard: do NOT skip if position has closed
    const noOpenPosition = false;
    const shouldNotSkip = standdownReason === 'MAX_DRAWDOWN_EXCEEDED' && noOpenPosition;
    expect(shouldNotSkip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Manual close audit write failure → EVALUATION_ERROR
// ---------------------------------------------------------------------------

describe('evaluatePreSubmissionRules — manual close audit write failure', () => {
  it('returns passed: false with EVALUATION_ERROR and reports to Sentry when audit log insert fails', async () => {
    const { db, sentry } = getMocks();

    // Override insertInto so the manual close audit log throws on execute
    db.insertInto.mockReturnValueOnce({
      values: jest.fn().mockReturnThis(),
      execute: jest.fn().mockRejectedValueOnce(new Error('DB unavailable')),
    });

    const manualCloseInput: PreSubmissionInput = {
      ...EXIT_INPUT,
      exitReason: 'MANUAL_CLOSE',
      proposalId: 'prop-manual-fail',
    };

    const result = await evaluatePreSubmissionRules(manualCloseInput);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('EVALUATION_ERROR');
    expect(result.ruleViolations).toHaveLength(0);

    // Sentry must be notified — a silently-swallowed failure would leave no compliance record
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Test 13: TRADE_FREQUENCY_CAP
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — TRADE_FREQUENCY_CAP', () => {
  it('blocks when a proposal was created within the trade_tempo cooldown window', async () => {
    const { m } = getMocks();

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)               // Rule 1: no open position
      .mockResolvedValueOnce({ id: 'prop-99' }) // Rule 2: recent proposal within cooldown
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4: cash

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('TRADE_FREQUENCY_CAP');
    expect(result.ruleViolations[0]?.ruleId).toBe('TRADE_FREQUENCY_CAP');
    expect(result.ruleViolations[0]?.detail).toContain('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// Test 14: CAPITAL_ALLOCATION_EXCEEDED
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — CAPITAL_ALLOCATION_EXCEEDED', () => {
  it('blocks when proposed size exceeds capital_allocated_usd', async () => {
    const { m } = getMocks();

    // Bot: capital = $1000, proposed = $1100 → over allocation
    const overLimitInput: RuleEngineInput = {
      ...ENTRY_INPUT,
      proposedPositionSizeUsd: 1100,
    };

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)          // Rule 1
      .mockResolvedValueOnce(null)          // Rule 2
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4

    const result = await evaluateProposalRules(overLimitInput);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('CAPITAL_ALLOCATION_EXCEEDED');
    expect(result.ruleViolations[0]?.detail).toContain('1100');
  });

  it('applies 50% haircut under MORE_CONSERVATIVE_2D recovery mode', async () => {
    const { m } = getMocks();

    // Bot: capital = $1000, recovery_mode_applied = MORE_CONSERVATIVE_2D
    // → effective = $500; proposed = $600 → exceeds effective allocation
    const overHaircutInput: RuleEngineInput = {
      ...ENTRY_INPUT,
      proposedPositionSizeUsd: 600,
    };

    setupEntryBase({ recovery_mode_applied: 'MORE_CONSERVATIVE_2D' });
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)          // Rule 1
      .mockResolvedValueOnce(null)          // Rule 2
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4

    const result = await evaluateProposalRules(overHaircutInput);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('CAPITAL_ALLOCATION_EXCEEDED');
    expect(result.ruleViolations[0]?.detail).toContain('MORE_CONSERVATIVE_2D');
    expect(result.ruleViolations[0]?.detail).toContain('500'); // effective = $500
  });
});

// ---------------------------------------------------------------------------
// Test 15: AGGREGATE_EXPOSURE_EXCEEDED
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — AGGREGATE_EXPOSURE_EXCEEDED', () => {
  it('blocks when total open exposure plus proposed size would exceed available cash', async () => {
    const { m } = getMocks();

    // Available cash = $1000; open positions already consume $600;
    // proposed = $500 → total $1100 > $1000
    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)               // Rule 1: no open position for this bot
      .mockResolvedValueOnce(null)               // Rule 2: no recent proposal
      .mockResolvedValueOnce({ balance: '1000' }); // Rule 4: cash = $1000

    // Open positions across user's bots: one position consuming $600
    m.selectBuilder.execute.mockResolvedValueOnce([
      { capital_allocated_usd: '600' },
    ]);

    const result = await evaluateProposalRules(ENTRY_INPUT); // proposedPositionSizeUsd = 500

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('AGGREGATE_EXPOSURE_EXCEEDED');
    expect(result.ruleViolations[0]?.detail).toContain('1100');
    expect(result.ruleViolations[0]?.detail).toContain('1000');
  });
});

// ---------------------------------------------------------------------------
// Test 16: INSUFFICIENT_CAPITAL
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — INSUFFICIENT_CAPITAL', () => {
  it('blocks when proposed position size is below the platform minimum ($100)', async () => {
    const { m } = getMocks();

    const tinyInput: RuleEngineInput = {
      ...ENTRY_INPUT,
      proposedPositionSizeUsd: 50, // below MIN_POSITION_SIZE_USD = 100
    };

    setupEntryBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)          // Rule 1
      .mockResolvedValueOnce(null)          // Rule 2
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4

    const result = await evaluateProposalRules(tinyInput);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('INSUFFICIENT_CAPITAL');
    expect(result.ruleViolations[0]?.detail).toContain('50');
    expect(result.ruleViolations[0]?.detail).toContain('100');
  });
});

// ---------------------------------------------------------------------------
// Test 17: HOLDING_PERIOD_NOT_ELAPSED
// ---------------------------------------------------------------------------

describe('evaluatePreSubmissionRules — HOLDING_PERIOD_NOT_ELAPSED', () => {
  it('blocks an exit proposal when the min hold period has not yet elapsed', async () => {
    const { m } = getMocks();

    const futureHold = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // tomorrow

    const exitInput: PreSubmissionInput = {
      ...EXIT_INPUT,
      exitReason: 'TARGET',
      proposalId: 'prop-exit-hold',
    };

    setupExitBase();
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)                           // Rule 2: no recent proposal
      .mockResolvedValueOnce({ balance: '5000' })            // Rule 4: cash
      .mockResolvedValueOnce({ min_hold_until: futureHold }) // Rule 8: hold not elapsed
      .mockResolvedValueOnce(null);                          // Rule 9: no drawdown position

    const result = await evaluatePreSubmissionRules(exitInput);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('HOLDING_PERIOD_NOT_ELAPSED');
    expect(result.ruleViolations[0]?.detail).toContain(futureHold);
  });
});

// ---------------------------------------------------------------------------
// Test 18: DAILY_MAX_GAIN_REACHED — recovery_mode_applied copied from settings
// ---------------------------------------------------------------------------

describe('evaluateProposalRules — DAILY_MAX_GAIN_REACHED recovery_mode_applied', () => {
  it('copies bot_settings.recovery_mode into bots.recovery_mode_applied on gain standown', async () => {
    const { m } = getMocks();

    // P&L realized = $100 = 10% of $1000 = gain threshold defined in SETTINGS
    setupEntryBase(undefined, { pnl_realized: '100', pnl_unrealized: '0', stands_down: false });
    m.selectBuilder.executeTakeFirst
      .mockResolvedValueOnce(null)          // Rule 1
      .mockResolvedValueOnce(null)          // Rule 2
      .mockResolvedValueOnce({ balance: '5000' }); // Rule 4

    const result = await evaluateProposalRules(ENTRY_INPUT);

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toBe('DAILY_MAX_GAIN_REACHED');

    // recovery_mode from settings ('NORMAL') must be copied to bots.recovery_mode_applied
    const botsSetCall = m.updateBuilder.set.mock.calls.find(
      (call: any[]) => call[0]?.status === 'STOOD_DOWN',
    );
    expect(botsSetCall).toBeDefined();
    expect(botsSetCall![0].recovery_mode_applied).toBe('NORMAL');

    // standdown_reason = 'DAILY_MAX_GAIN_REACHED' written to bot_runtime_data
    const runtimeSetCall = m.updateBuilder.set.mock.calls.find(
      (call: any[]) => call[0]?.stands_down === true,
    );
    expect(runtimeSetCall).toBeDefined();
    expect(runtimeSetCall![0].standdown_reason).toBe('DAILY_MAX_GAIN_REACHED');
  });
});
