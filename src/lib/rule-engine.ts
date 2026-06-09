/**
 * Deterministic Rule Engine
 *
 * Enforces all safety and risk limits before a trade proposal is surfaced to the
 * user (proposal_pre_check) and again at the moment the user approves it
 * (pre_submission). Rules are deterministic — no AI involvement, no probabilistic
 * decisions. Compliance with these rules is mandatory; this engine is the final
 * authority on whether a trade can proceed.
 *
 * Public API:
 *   evaluateProposalRules()      — called by scan-bot worker when a
 *                                  new proposal is generated. Determines whether
 *                                  the proposal is eligible to be shown.
 *   evaluatePreSubmissionRules() — called by the approval flow the
 *                                  moment the user taps "Approve". Catches state
 *                                  changes that occurred between proposal creation
 *                                  and approval (e.g. bot stood down, daily limit
 *                                  reached mid-day).
 *
 * Rule execution order (both evaluation types unless noted):
 *   1. OPEN_POSITION_EXISTS        — entry only; skip if isExitProposal
 *   2. TRADE_FREQUENCY_CAP         — both
 *   3. CAPITAL_ALLOCATION_EXCEEDED — both
 *   4. AGGREGATE_EXPOSURE_EXCEEDED — both
 *   5. INSUFFICIENT_CAPITAL        — both
 *   6. DAILY_MAX_LOSS_REACHED      — entry only; triggers STOOD_DOWN
 *   7. DAILY_MAX_GAIN_REACHED      — entry only; triggers STOOD_DOWN
 *   8. HOLDING_PERIOD_NOT_ELAPSED  — exit only; bypassed when exitReason=STOP_LOSS
 *   9. MAX_DRAWDOWN_EXCEEDED       — exit only; triggers STOOD_DOWN (no recovery mode)
 *
 * All rules run in sequence — the loop does not short-circuit on the first
 * violation. The first violation's ruleId becomes the top-level rejectionReason;
 * all violations are recorded in rule_violations for the audit log.
 *
 * Stand-down behavior:
 *   DAILY_MAX_LOSS_REACHED and DAILY_MAX_GAIN_REACHED set bots.status = STOOD_DOWN
 *   and copy bot_settings.recovery_mode into bots.recovery_mode_applied. The
 *   NYSE-open reset cron reads this value to determine re-activation logic.
 *
 *   MAX_DRAWDOWN_EXCEEDED sets bots.status = STOOD_DOWN but explicitly sets
 *   recovery_mode_applied = NULL. The bot stays STOOD_DOWN until the open position
 *   closes - the reset cron skips it while a position is open.
 *
 * Atomicity guarantee:
 *   Every evaluation runs inside a single db.transaction(). The STOOD_DOWN status
 *   write, the bot_runtime_data update, and the rule_audit_log insert all commit
 *   together or not at all. The bots row is locked with SELECT ... FOR UPDATE at
 *   the start of the transaction to prevent duplicate STOOD_DOWN writes from
 *   concurrent scan-bot jobs evaluating the same bot simultaneously.
 *
 * Fail-safe (NFR7):
 *   Any unhandled exception inside the transaction (DB error, timeout, missing row)
 *   is caught, reported to Sentry, and causes the evaluation to return
 *   { passed: false, rejectionReason: 'EVALUATION_ERROR' }. The engine never
 *   defaults to PASS on error.
 *
 * Unrealized P&L:
 *   Rules 6 and 9 accept an UnrealizedPnLProvider. The default stubbedPnLProvider
 *   returns 0 (conservative — no loss assumed). Feature 14 will inject the real
 *   Alpaca equity data provider. Until then, MAX_DRAWDOWN_EXCEEDED and the
 *   unrealized component of DAILY_MAX_LOSS will not fire in production.
 *
 * Scope boundary:
 *   This module provides the rule functions only. The call sites that invoke
 *   evaluateProposalRules() and evaluatePreSubmissionRules() are Feature 11
 *   (scan-bot worker) and Feature 14 (order submission worker) respectively.
 *   scan-bot.worker.ts is NOT modified by this task.
 */
import { sql } from "kysely";
import type { Transaction, SqlBool } from "kysely";
import * as Sentry from "@sentry/node";
import type {
  RuleEngineInput,
  PreSubmissionInput,
  RuleEngineResult,
  RuleViolation,
  RejectionReason,
} from "@tachyonapp/tachyon-queue-types";
import { TRADE_TEMPO_RULES } from "@tachyonapp/tachyon-queue-types";
import { db } from "../db";
import type { DB } from "@tachyonapp/tachyon-db";

// Minimum position size enforced by the platform.
// PLATFORM_LIMITS.minPositionSizeUsd is not yet defined in tachyon-queue-types;
// using a local constant until that key is added (post-migration-013).
const MIN_POSITION_SIZE_USD = 100;

// === Public Interface ===

export interface UnrealizedPnLProvider {
  getUnrealizedPnL(positionId: string): Promise<number>;
}

// Default stub for Phase 3 testing.
// Returns 0 — conservative: no unrealized loss assumed.
// Feature 14's broker adapter will replace this with real Alpaca equity data.
// Known alpha limitation: MAX_DRAWDOWN_EXCEEDED and unrealized daily loss will not
// trigger until the real provider is wired in.
export const stubbedPnLProvider: UnrealizedPnLProvider = {
  getUnrealizedPnL: async () => 0,
};

export async function evaluateProposalRules(
  input: RuleEngineInput,
  pnlProvider: UnrealizedPnLProvider = stubbedPnLProvider,
): Promise<RuleEngineResult> {
  return runEvaluation(input, "proposal_pre_check", pnlProvider);
}

export async function evaluatePreSubmissionRules(
  input: PreSubmissionInput,
  pnlProvider: UnrealizedPnLProvider = stubbedPnLProvider,
): Promise<RuleEngineResult> {
  // Manual close bypasses all rules — user-initiated close is always allowed.
  // The audit log write is NOT optional: failing to record a manual close is a
  // compliance gap. If the write fails, surface EVALUATION_ERROR rather than
  // silently proceeding without an audit record.
  if (input.exitReason === "MANUAL_CLOSE") {
    try {
      await writeManualCloseAuditLog(input);
      return { passed: true, ruleViolations: [] };
    } catch (err) {
      Sentry.captureException(err, {
        extra: { botId: input.botId, userId: input.userId },
      });
      return {
        passed: false,
        rejectionReason: "EVALUATION_ERROR",
        ruleViolations: [],
      };
    }
  }
  return runEvaluation(input, "pre_submission", pnlProvider);
}

// === Internal Types ===

interface RuleContext {
  input: RuleEngineInput;
  bot: {
    id: string;
    userId: string;
    capitalAllocatedUsd: number;
    recoveryModeApplied: string | null;
  };
  botSettings: {
    dailyMaxLossPct: number;
    // Maps from bot_settings.daily_max_gain (column does not have _pct suffix in current schema)
    dailyMaxGainPct: number;
    combatPatience: string;
    tradeTempo: string;
    maxDrawdownProtectionPct: number;
    recoveryMode: string | null;
  };
  runtimeData: {
    pnlRealized: number;
    pnlUnrealized: number;
    standsDown: boolean;
  } | null;
}

type RuleCheck = (
  ctx: RuleContext,
  tx: Transaction<DB>,
) => Promise<RuleViolation | null>;

// === Core Evaluation Runner ===

async function runEvaluation(
  input: RuleEngineInput,
  evaluationType: "proposal_pre_check" | "pre_submission",
  pnlProvider: UnrealizedPnLProvider,
): Promise<RuleEngineResult> {
  const violations: RuleViolation[] = [];
  let rejectionReason: RejectionReason | undefined;
  let passed = true;

  try {
    await db.transaction().execute(async (tx) => {
      // Acquire row-level lock on bots row to serialize concurrent evaluations
      // for the same bot. This prevents race conditions when two scan-bot jobs
      // evaluate the same bot simultaneously and both attempt STOOD_DOWN writes.
      const bot = await tx
        .selectFrom("bots")
        .where("id", "=", input.botId)
        .select([
          "id",
          "user_id",
          "capital_allocated_usd",
          "status",
          "recovery_mode_applied",
        ])
        .forUpdate()
        .executeTakeFirst();

      if (!bot) {
        throw new Error(`Bot ${input.botId} not found during rule evaluation`);
      }

      const botSettings = await tx
        .selectFrom("bot_settings")
        .innerJoin("bots", "bots.current_settings_id", "bot_settings.id")
        .where("bots.id", "=", input.botId)
        .select([
          "bot_settings.daily_max_loss_pct",
          "bot_settings.daily_max_gain",
          "bot_settings.combat_patience",
          "bot_settings.trade_tempo",
          "bot_settings.max_drawdown_protection_pct",
          "bot_settings.recovery_mode",
        ])
        .executeTakeFirst();

      if (!botSettings) {
        throw new Error(`BotSettings for bot ${input.botId} not found`);
      }

      const runtimeData = await tx
        .selectFrom("bot_runtime_data")
        .where("bot_id", "=", input.botId)
        .where(sql<SqlBool>`trading_day = CURRENT_DATE`)
        .select(["pnl_realized", "pnl_unrealized", "stands_down"])
        .executeTakeFirst();

      const ctx: RuleContext = {
        input,
        bot: {
          id: String(bot.id),
          userId: String(bot.user_id),
          capitalAllocatedUsd: Number(bot.capital_allocated_usd),
          recoveryModeApplied: bot.recovery_mode_applied ?? null,
        },
        botSettings: {
          dailyMaxLossPct: Number(botSettings.daily_max_loss_pct),
          dailyMaxGainPct: Number(botSettings.daily_max_gain),
          combatPatience: botSettings.combat_patience,
          tradeTempo: botSettings.trade_tempo,
          maxDrawdownProtectionPct: Number(
            botSettings.max_drawdown_protection_pct,
          ),
          recoveryMode: botSettings.recovery_mode ?? null,
        },
        runtimeData: runtimeData
          ? {
              pnlRealized: Number(runtimeData.pnl_realized),
              pnlUnrealized: Number(runtimeData.pnl_unrealized),
              standsDown: runtimeData.stands_down,
            }
          : null,
      };

      // Rules run sequentially. See TDD for full execution order and bypass rules.
      const rules: RuleCheck[] = [
        checkOpenPositionExists,
        checkTradeFrequencyCap,
        checkCapitalAllocationExceeded,
        checkAggregateExposureExceeded,
        checkInsufficientCapital,
        checkDailyMaxLoss,
        checkDailyMaxGain,
        checkHoldingPeriodNotElapsed,
        checkMaxDrawdownExceeded(pnlProvider),
      ];

      for (const rule of rules) {
        const violation = await rule(ctx, tx);
        if (violation) {
          violations.push(violation);
          if (!rejectionReason) {
            rejectionReason = violation.ruleId as RejectionReason;
            passed = false;
          }
          // Stand-down trigger: daily loss/gain limits AND max drawdown cause immediate bot status update.
          // MAX_DRAWDOWN standown: recovery_mode_applied is set to NULL — recovery mode does NOT apply.
          // The bot remains STOOD_DOWN until the position closes (Feature 14 clears it after fill),
          // not until the NYSE open reset cron (which skips bots with standdown_reason=MAX_DRAWDOWN_EXCEEDED
          // when a position is still open). See Task 04 reset cron guard.
          //
          // TODO: Dual standown edge case — if DAILY_MAX_LOSS_REACHED and MAX_DRAWDOWN_EXCEEDED both
          // fire in the same evaluation (possible once Feature 14 wires the real Alpaca P&L provider),
          // the second bots UPDATE overwrites the first. Concretely: DAILY_MAX_LOSS fires first, writes
          // recovery_mode_applied = 'NORMAL'; MAX_DRAWDOWN fires second, overwrites with NULL. The reset
          // cron then treats the bot as a drawdown standown and skips recovery mode re-activation. This
          // is alpha-safe (stubbedPnLProvider always returns 0, so MAX_DRAWDOWN never fires), but must
          // be hardened before Feature 14 ships. Fix: track violations and apply the strictest standown
          // semantics (NULL wins over any recovery_mode_applied value) in a single write after the loop.
          const isStanddownTrigger =
            violation.ruleId === "DAILY_MAX_LOSS_REACHED" ||
            violation.ruleId === "DAILY_MAX_GAIN_REACHED" ||
            violation.ruleId === "MAX_DRAWDOWN_EXCEEDED";

          if (isStanddownTrigger) {
            const isDrawdown = violation.ruleId === "MAX_DRAWDOWN_EXCEEDED";
            await tx
              .updateTable("bots")
              .set({
                status: "STOOD_DOWN",
                // Drawdown standowns carry no recovery mode — bot resets to full capacity
                // once the position closes (Feature 14 scope). Daily loss/gain standowns
                // apply the user-configured recovery mode.
                recovery_mode_applied: isDrawdown
                  ? null
                  : botSettings.recovery_mode,
              })
              .where("id", "=", input.botId)
              .execute();

            await tx
              .updateTable("bot_runtime_data")
              .set({
                stands_down: true,
                standdown_reason: violation.ruleId,
              })
              .where("bot_id", "=", input.botId)
              .where(sql<SqlBool>`trading_day = CURRENT_DATE`)
              .execute();
          }
        }
      }

      // Write audit log entry — always, regardless of pass/fail
      await tx
        .insertInto("rule_audit_log")
        .values({
          bot_id: BigInt(input.botId),
          user_id: BigInt(input.userId),
          evaluation_type: evaluationType,
          passed,
          rejection_reason: rejectionReason ?? null,
          rule_violations: JSON.stringify(violations),
          input_snapshot: JSON.stringify(input),
          evaluated_at: new Date(),
        })
        .execute();
    });
  } catch (err) {
    Sentry.captureException(err, {
      extra: { botId: input.botId, userId: input.userId },
    });

    // Fail-safe (NFR7): any DB error → reject the trade. Never default to PASS on error.
    return {
      passed: false,
      rejectionReason: "EVALUATION_ERROR",
      ruleViolations: [],
    };
  }

  return { passed, rejectionReason, ruleViolations: violations };
}

// Manual close bypass — writes a single audit log entry, no rule checks.
// No try/catch here — let exceptions propagate to evaluatePreSubmissionRules,
// which surfaces EVALUATION_ERROR. Silently swallowing a DB failure would leave
// a manual close with no audit record, which is a compliance gap.
async function writeManualCloseAuditLog(
  input: PreSubmissionInput,
): Promise<void> {
  await db
    .insertInto("rule_audit_log")
    .values({
      bot_id: BigInt(input.botId),
      user_id: BigInt(input.userId),
      evaluation_type: "pre_submission",
      passed: true,
      rejection_reason: null,
      rule_violations: JSON.stringify([]),
      input_snapshot: JSON.stringify({
        ...input,
        bypass: "USER_INITIATED_CLOSE",
      }),
      evaluated_at: new Date(),
    })
    .execute();
}

// === Rule Implementations ===

// Rule 1: OPEN_POSITION_EXISTS (FR12) — entry blocked if agent has open position
const checkOpenPositionExists: RuleCheck = async (ctx, tx) => {
  if (ctx.input.isExitProposal) return null;
  const openPosition = await tx
    .selectFrom("positions")
    .where("bot_id", "=", ctx.input.botId)
    .where("status", "=", "OPEN")
    .select("id")
    .executeTakeFirst();
  if (openPosition) {
    return {
      ruleId: "OPEN_POSITION_EXISTS",
      detail: "Bot already has an open position.",
    };
  }
  return null;
};

// Rule 2: TRADE_FREQUENCY_CAP (FR13) — min interval between proposals per trade_tempo
const checkTradeFrequencyCap: RuleCheck = async (ctx, tx) => {
  const tempoRule =
    TRADE_TEMPO_RULES[
      ctx.botSettings.tradeTempo as keyof typeof TRADE_TEMPO_RULES
    ];
  if (!tempoRule) return null;

  const minMinutes = tempoRule.minMinutesBetweenProposals;
  const cutoff = new Date(Date.now() - minMinutes * 60 * 1000);

  const recentProposal = await tx
    .selectFrom("trade_proposals")
    .where("bot_id", "=", ctx.input.botId)
    .where("created_at", ">=", cutoff)
    .select("id")
    .executeTakeFirst();

  if (recentProposal) {
    return {
      ruleId: "TRADE_FREQUENCY_CAP",
      detail: `Proposal created within the ${minMinutes}-minute cooldown window for trade_tempo=${ctx.botSettings.tradeTempo}.`,
    };
  }
  return null;
};

// Rule 3: CAPITAL_ALLOCATION_EXCEEDED (FR3) — proposed size ≤ capital_allocated_usd
const checkCapitalAllocationExceeded: RuleCheck = async (ctx) => {
  const effective =
    ctx.bot.recoveryModeApplied === "MORE_CONSERVATIVE_2D"
      ? ctx.bot.capitalAllocatedUsd * 0.5
      : ctx.bot.capitalAllocatedUsd;

  if (ctx.input.proposedPositionSizeUsd > effective) {
    return {
      ruleId: "CAPITAL_ALLOCATION_EXCEEDED",
      detail: `Proposed size $${ctx.input.proposedPositionSizeUsd} exceeds effective allocation $${effective} (recovery mode: ${ctx.bot.recoveryModeApplied ?? "none"}).`,
    };
  }
  return null;
};

// Rule 4: AGGREGATE_EXPOSURE_EXCEEDED (FR4) — sum of open positions ≤ available cash
const checkAggregateExposureExceeded: RuleCheck = async (ctx, tx) => {
  const cashAccount = await tx
    .selectFrom("user_cash_accounts")
    .where("user_id", "=", ctx.input.userId)
    .select("balance")
    .executeTakeFirst();

  if (!cashAccount) return null;

  const openPositions = await tx
    .selectFrom("positions")
    .innerJoin("bots", "bots.id", "positions.bot_id")
    .where("bots.user_id", "=", ctx.input.userId)
    .where("positions.status", "=", "OPEN")
    .select("positions.capital_allocated_usd")
    .execute();

  const totalExposed = openPositions.reduce(
    (sum, p) => sum + Number(p.capital_allocated_usd),
    0,
  );

  const availableCash = Number(cashAccount.balance);
  if (totalExposed + ctx.input.proposedPositionSizeUsd > availableCash) {
    return {
      ruleId: "AGGREGATE_EXPOSURE_EXCEEDED",
      detail: `Total exposure $${totalExposed + ctx.input.proposedPositionSizeUsd} would exceed available cash $${availableCash}.`,
    };
  }
  return null;
};

// Rule 5: INSUFFICIENT_CAPITAL (FR4b) — effective size ≥ platform minimum
const checkInsufficientCapital: RuleCheck = async (ctx) => {
  if (ctx.input.proposedPositionSizeUsd < MIN_POSITION_SIZE_USD) {
    return {
      ruleId: "INSUFFICIENT_CAPITAL",
      detail: `Proposed size $${ctx.input.proposedPositionSizeUsd} is below platform minimum $${MIN_POSITION_SIZE_USD}.`,
    };
  }
  return null;
};

// Rule 6: DAILY_MAX_LOSS_REACHED (FR5) — daily P&L ≥ loss threshold → STOOD_DOWN
// Note: unrealized P&L comes from runtimeData (seeded by reconciliation worker),
// not from a live broker call. The stubbedPnLProvider is only used for Rule 9
// (MAX_DRAWDOWN_EXCEEDED); Rule 6 reads the already-stored value from bot_runtime_data.
const checkDailyMaxLoss: RuleCheck = async (ctx) => {
  if (!ctx.input.isExitProposal) {
    const realized = ctx.runtimeData?.pnlRealized ?? 0;
    const unrealized = ctx.runtimeData?.pnlUnrealized ?? 0;
    const totalLoss = realized + unrealized;
    const threshold = -(
      ctx.bot.capitalAllocatedUsd * ctx.botSettings.dailyMaxLossPct
    );

    if (totalLoss <= threshold) {
      return {
        ruleId: "DAILY_MAX_LOSS_REACHED",
        detail: `Daily P&L ${totalLoss.toFixed(2)} reached loss threshold ${threshold.toFixed(2)}.`,
      };
    }
  }
  return null;
};

// Rule 7: DAILY_MAX_GAIN_REACHED (FR6) — daily realized P&L ≥ gain threshold → STOOD_DOWN
const checkDailyMaxGain: RuleCheck = async (ctx) => {
  if (!ctx.input.isExitProposal) {
    const realized = ctx.runtimeData?.pnlRealized ?? 0;
    const threshold =
      ctx.bot.capitalAllocatedUsd * ctx.botSettings.dailyMaxGainPct;

    if (realized >= threshold) {
      return {
        ruleId: "DAILY_MAX_GAIN_REACHED",
        detail: `Daily realized P&L ${realized.toFixed(2)} reached gain threshold ${threshold.toFixed(2)}.`,
      };
    }
  }
  return null;
};

// Rule 8: HOLDING_PERIOD_NOT_ELAPSED (FR9) — exit blocked until min_hold_until
// Bypass: skip when exitReason === 'STOP_LOSS'
const checkHoldingPeriodNotElapsed: RuleCheck = async (ctx, tx) => {
  if (!ctx.input.isExitProposal) return null;
  if (ctx.input.exitReason === "STOP_LOSS") return null; // FR10 bypass

  const position = await tx
    .selectFrom("positions")
    .where("bot_id", "=", ctx.input.botId)
    .where("status", "=", "OPEN")
    .select("min_hold_until")
    .executeTakeFirst();

  if (
    position?.min_hold_until &&
    new Date() < new Date(position.min_hold_until)
  ) {
    return {
      ruleId: "HOLDING_PERIOD_NOT_ELAPSED",
      detail: `Min hold period not elapsed. Can exit after ${position.min_hold_until}.`,
    };
  }
  return null;
};

// Rule 9: MAX_DRAWDOWN_EXCEEDED (FR14) — unrealized loss ≥ max_drawdown_protection_pct
const checkMaxDrawdownExceeded =
  (pnlProvider: UnrealizedPnLProvider): RuleCheck =>
  async (ctx, tx) => {
    if (!ctx.input.isExitProposal) return null;

    const position = await tx
      .selectFrom("positions")
      .where("bot_id", "=", ctx.input.botId)
      .where("status", "=", "OPEN")
      .select(["id", "capital_allocated_usd"])
      .executeTakeFirst();

    if (!position) return null;

    const unrealizedPnL = await pnlProvider.getUnrealizedPnL(
      String(position.id),
    );
    const threshold = -(
      Number(position.capital_allocated_usd) *
      ctx.botSettings.maxDrawdownProtectionPct
    );

    if (unrealizedPnL <= threshold) {
      return {
        ruleId: "MAX_DRAWDOWN_EXCEEDED",
        detail: `Unrealized P&L ${unrealizedPnL.toFixed(2)} exceeded max drawdown threshold ${threshold.toFixed(2)}.`,
      };
    }
    return null;
  };
