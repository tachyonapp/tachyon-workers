// Prevent BullMQ Worker from opening Redis connections during unit tests
jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
  Queue: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@sentry/node", () => ({
  captureException: jest.fn(),
}));

jest.mock("../../lib/staleness-gate", () => ({
  evaluateStalenessGate: jest.fn(),
}));

// resolveRelevantParentSectors stays real (pure, already unit-tested against
// real ALLOWED_SECTORS/TIER_B_SUB_SECTORS) — only runFilterChain is mocked.
jest.mock("../../lib/universe-filter-chain", () => ({
  ...jest.requireActual("../../lib/universe-filter-chain"),
  runFilterChain: jest.fn(),
}));

jest.mock("../../lib/session-preference", () => ({
  isWithinSessionPreference: jest.fn(),
  isDayAvoided: jest.fn(),
}));

interface SelectChain {
  where: jest.Mock;
  innerJoin: jest.Mock;
  select: jest.Mock;
  executeTakeFirst: jest.Mock;
}

interface InsertChain {
  values: jest.Mock;
  execute: jest.Mock;
}

function makeSelectChain(result: unknown): SelectChain {
  const chain = {} as SelectChain;
  chain.where = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.executeTakeFirst = jest.fn().mockResolvedValue(result);
  return chain;
}

function makeInsertChain(): InsertChain {
  const chain = {} as InsertChain;
  chain.values = jest.fn().mockReturnValue(chain);
  chain.execute = jest.fn().mockResolvedValue(undefined);
  return chain;
}

jest.mock("../../db", () => ({
  db: { selectFrom: jest.fn(), insertInto: jest.fn() },
}));

import * as Sentry from "@sentry/node";
import type { Job } from "bullmq";
import type { ScanBotJobPayload } from "@tachyonapp/tachyon-queue-types";
import { processScanBot } from "../scan-bot.worker";
import { db } from "../../db";
import { evaluateStalenessGate } from "../../lib/staleness-gate";
import { runFilterChain } from "../../lib/universe-filter-chain";
import { isWithinSessionPreference, isDayAvoided } from "../../lib/session-preference";

const mockedSelectFrom = db.selectFrom as jest.Mock;
const mockedInsertInto = db.insertInto as jest.Mock;
const mockedEvaluateStalenessGate = evaluateStalenessGate as jest.Mock;
const mockedRunFilterChain = runFilterChain as jest.Mock;
const mockedIsWithinSessionPreference = isWithinSessionPreference as jest.Mock;
const mockedIsDayAvoided = isDayAvoided as jest.Mock;

const BOT_ROW = { id: "1", user_id: "1", name: "TestBot" };
const BROKER_ROW = { id: "1", provider_name: "alpaca" };
const SUBSCRIPTION_ROW = { tier: "TACHYON_HOSTED" };
const BOT_CONFIG_ROW = {
  frame_name: "CATALYST",
  sub_sectors: [],
  custom_watchlist: [],
  exclusion_list: [],
  dividend_preference: null,
  short_interest_signal: null,
  session_preference: null,
  day_avoidance: [],
  earnings_behavior: null,
};

const PASS_GATE_RESULT = {
  outcome: "PASS",
  candidateSymbols: [
    {
      symbol: "AAPL",
      parentSector: "Technology",
      marketCapUsd: 3_000_000_000_000,
      avgDollarVolume: 9_000_000_000,
      resolvedSubSectors: ["Consumer Electronics"],
      dividendYield: null,
      shortInterestPct: null,
      nextEarningsDate: null,
      price: 190,
    },
  ],
  audit: {
    bucketKey: "universe:bucket:Technology:MEGA_CAP",
    tier: "FAST" as const,
    asOf: new Date().toISOString(),
    ageSeconds: 30,
    thresholdSeconds: 240,
    breakerOpen: false,
  },
};

function makeJob(): Job<ScanBotJobPayload> {
  return { data: { botId: "1", userId: "1" }, id: "job-1" } as Job<ScanBotJobPayload>;
}

// Sets up the four selectFrom calls scan-bot.worker.ts issues, in call order:
// bots, broker_connections, user_subscriptions, bot_settings(+joins).
//
// Pass `null` (not `undefined`) to simulate "row not found" — JS default
// parameters substitute the default for an explicit `undefined` too, so
// `undefined` can't be distinguished from "no override given" here.
function setupSelectChain({
  bot = BOT_ROW,
  broker = BROKER_ROW,
  subscription = SUBSCRIPTION_ROW,
  botConfig = BOT_CONFIG_ROW,
}: {
  bot?: unknown;
  broker?: unknown;
  subscription?: unknown;
  botConfig?: unknown;
} = {}) {
  const toRowResult = (v: unknown) => (v === null ? undefined : v);
  mockedSelectFrom
    .mockReturnValueOnce(makeSelectChain(toRowResult(bot)))
    .mockReturnValueOnce(makeSelectChain(toRowResult(broker)))
    .mockReturnValueOnce(makeSelectChain(toRowResult(subscription)))
    .mockReturnValueOnce(makeSelectChain(toRowResult(botConfig)));
}

describe("processScanBot", () => {
  let insertChain: InsertChain;

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): a test that returns early after
    // consuming only some of setupSelectChain's four queued
    // mockReturnValueOnce values would otherwise leak the rest into the next
    // test — clearAllMocks resets call history but NOT pending once-queues.
    jest.resetAllMocks();
    insertChain = makeInsertChain();
    mockedInsertInto.mockReturnValue(insertChain);
    mockedIsWithinSessionPreference.mockReturnValue(true);
    mockedIsDayAvoided.mockReturnValue(false);
    mockedEvaluateStalenessGate.mockResolvedValue(PASS_GATE_RESULT);
    mockedRunFilterChain.mockReturnValue({
      candidates: [{ symbol: "AAPL", marketDataSnapshot: PASS_GATE_RESULT.candidateSymbols[0] }],
    });
  });

  describe("pre-existing guards (unchanged)", () => {
    it("no-ops without touching Steps 4-10 when the bot is not ACTIVE/owned", async () => {
      setupSelectChain({ bot: null });

      await processScanBot(makeJob());

      expect(mockedEvaluateStalenessGate).not.toHaveBeenCalled();
      expect(mockedInsertInto).not.toHaveBeenCalled();
    });

    it("no-ops when there is no ACTIVE broker connection", async () => {
      setupSelectChain({ broker: null });

      await processScanBot(makeJob());

      expect(mockedEvaluateStalenessGate).not.toHaveBeenCalled();
    });

    it("no-ops when there is no subscription row", async () => {
      setupSelectChain({ subscription: null });

      await processScanBot(makeJob());

      expect(mockedEvaluateStalenessGate).not.toHaveBeenCalled();
    });

    it("still reaches Steps 4-10 once all three guards pass", async () => {
      setupSelectChain();

      await processScanBot(makeJob());

      expect(mockedEvaluateStalenessGate).toHaveBeenCalledTimes(1);
    });
  });

  describe("Step 5 — session/day narrowing (FR7)", () => {
    it("produces NO scan_audit_log row when the day is avoided", async () => {
      setupSelectChain();
      mockedIsDayAvoided.mockReturnValue(true);

      await processScanBot(makeJob());

      expect(mockedEvaluateStalenessGate).not.toHaveBeenCalled();
      expect(mockedInsertInto).not.toHaveBeenCalled();
    });

    it("produces NO scan_audit_log row when outside the session preference window", async () => {
      setupSelectChain();
      mockedIsWithinSessionPreference.mockReturnValue(false);

      await processScanBot(makeJob());

      expect(mockedEvaluateStalenessGate).not.toHaveBeenCalled();
      expect(mockedInsertInto).not.toHaveBeenCalled();
    });
  });

  describe("Steps 6-10 — staleness gate, audit write, filter chain", () => {
    it("PASS: writes exactly one scan_audit_log row and logs the candidate list", async () => {
      setupSelectChain();

      await processScanBot(makeJob());

      expect(mockedInsertInto).toHaveBeenCalledTimes(1);
      expect(mockedInsertInto).toHaveBeenCalledWith("scan_audit_log");
      const insertedValues = insertChain.values.mock.calls[0][0];
      expect(insertedValues.outcome).toBe("PASS");
      expect(insertedValues.bot_id).toBe("1");
      expect(mockedRunFilterChain).toHaveBeenCalledTimes(1);
    });

    it("SKIPPED: still writes exactly one scan_audit_log row, but never calls the filter chain", async () => {
      setupSelectChain();
      mockedEvaluateStalenessGate.mockResolvedValue({
        outcome: "SKIPPED",
        candidateSymbols: [],
        audit: {
          bucketKey: "universe:bucket:Technology:MEGA_CAP",
          tier: "FAST",
          asOf: null,
          ageSeconds: null,
          thresholdSeconds: 240,
          breakerOpen: false,
        },
      });

      await processScanBot(makeJob());

      expect(mockedInsertInto).toHaveBeenCalledTimes(1);
      const insertedValues = insertChain.values.mock.calls[0][0];
      expect(insertedValues.outcome).toBe("SKIPPED");
      // -1 sentinel for "no prior data" — never a real elapsed age.
      expect(insertedValues.age_seconds).toBe(-1);
      expect(mockedRunFilterChain).not.toHaveBeenCalled();
    });

    it("SLOW_TIER_DEGRADED_SERVE: writes the audit row and still runs the filter chain", async () => {
      setupSelectChain();
      mockedEvaluateStalenessGate.mockResolvedValue({
        outcome: "SLOW_TIER_DEGRADED_SERVE",
        candidateSymbols: PASS_GATE_RESULT.candidateSymbols,
        audit: {
          bucketKey: "universe:bucket:Technology:MEGA_CAP",
          tier: "SLOW",
          asOf: new Date().toISOString(),
          ageSeconds: 50_000,
          thresholdSeconds: 3000,
          breakerOpen: true,
        },
      });

      await processScanBot(makeJob());

      const insertedValues = insertChain.values.mock.calls[0][0];
      expect(insertedValues.outcome).toBe("SLOW_TIER_DEGRADED_SERVE");
      expect(insertedValues.breaker_open).toBe(true);
      expect(mockedRunFilterChain).toHaveBeenCalledTimes(1);
    });

    it("resolves relevant buckets from the bot's frame and sub_sectors and passes them to the staleness gate", async () => {
      setupSelectChain({
        botConfig: { ...BOT_CONFIG_ROW, sub_sectors: ["Software & SaaS"] },
      });

      await processScanBot(makeJob());

      const passedBuckets = mockedEvaluateStalenessGate.mock.calls[0][0];
      // CATALYST's marketCapTiers are [MEGA_CAP, LARGE_CAP]; "Software & SaaS"
      // resolves to the Technology parent sector only.
      expect(passedBuckets).toEqual(
        expect.arrayContaining([
          { parentSector: "Technology", marketCapTier: "MEGA_CAP" },
          { parentSector: "Technology", marketCapTier: "LARGE_CAP" },
        ]),
      );
      expect(passedBuckets).toHaveLength(2);
    });
  });

  describe("error handling — pipeline failures do not crash the worker", () => {
    it("catches a thrown error, Sentry-captures it, and resolves without rethrowing", async () => {
      setupSelectChain();
      mockedEvaluateStalenessGate.mockRejectedValue(new Error("Valkey unreachable"));

      await expect(processScanBot(makeJob())).resolves.toBeUndefined();
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it("throws internally (caught) when bot_settings/frame is missing, without crashing the job", async () => {
      setupSelectChain({ botConfig: null });

      await expect(processScanBot(makeJob())).resolves.toBeUndefined();
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(mockedEvaluateStalenessGate).not.toHaveBeenCalled();
    });

    it("throws internally (caught) when the bot's frame name is unrecognized", async () => {
      setupSelectChain({ botConfig: { ...BOT_CONFIG_ROW, frame_name: "NOT_A_REAL_FRAME" } });

      await expect(processScanBot(makeJob())).resolves.toBeUndefined();
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });
  });
});
