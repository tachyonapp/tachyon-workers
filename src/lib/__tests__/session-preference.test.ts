import { DateTime, Settings } from "luxon";
import { isWithinSessionPreference, isDayAvoided } from "../session-preference";

describe("isWithinSessionPreference", () => {
  afterEach(() => {
    Settings.now = () => Date.now();
  });

  function setNYTime(isoLocalString: string) {
    const dt = DateTime.fromISO(isoLocalString, { zone: "America/New_York" });
    Settings.now = () => dt.toMillis();
  }

  it("FULL_SESSION applies no narrowing at 10am", () => {
    setNYTime("2026-09-21T10:00:00");
    expect(isWithinSessionPreference("FULL_SESSION")).toBe(true);
  });

  it("null (unset preference) applies no narrowing, same as FULL_SESSION", () => {
    setNYTime("2026-09-21T15:59:00");
    expect(isWithinSessionPreference(null)).toBe(true);
  });

  it("MORNING_HUNTER passes at 9:30 (open) and fails at 12:00 (midday)", () => {
    setNYTime("2026-09-21T09:30:00");
    expect(isWithinSessionPreference("MORNING_HUNTER")).toBe(true);
    setNYTime("2026-09-21T12:00:00");
    expect(isWithinSessionPreference("MORNING_HUNTER")).toBe(false);
    setNYTime("2026-09-21T11:59:00");
    expect(isWithinSessionPreference("MORNING_HUNTER")).toBe(true);
  });

  it("AFTERNOON_HUNTER passes at 12:00 (midday) and fails before it or at close", () => {
    setNYTime("2026-09-21T12:00:00");
    expect(isWithinSessionPreference("AFTERNOON_HUNTER")).toBe(true);
    setNYTime("2026-09-21T11:59:00");
    expect(isWithinSessionPreference("AFTERNOON_HUNTER")).toBe(false);
    setNYTime("2026-09-21T16:00:00");
    expect(isWithinSessionPreference("AFTERNOON_HUNTER")).toBe(false);
  });

  it("AVOID_FIRST_30 fails during the first 30 minutes and passes right after", () => {
    setNYTime("2026-09-21T09:45:00");
    expect(isWithinSessionPreference("AVOID_FIRST_30")).toBe(false);
    setNYTime("2026-09-21T09:59:59");
    expect(isWithinSessionPreference("AVOID_FIRST_30")).toBe(false);
    setNYTime("2026-09-21T10:00:00");
    expect(isWithinSessionPreference("AVOID_FIRST_30")).toBe(true);
    setNYTime("2026-09-21T15:59:00");
    expect(isWithinSessionPreference("AVOID_FIRST_30")).toBe(true);
  });
});

describe("isDayAvoided", () => {
  afterEach(() => {
    Settings.now = () => Date.now();
  });

  function setNYTime(isoLocalString: string) {
    const dt = DateTime.fromISO(isoLocalString, { zone: "America/New_York" });
    Settings.now = () => dt.toMillis();
  }

  it("returns false when day_avoidance is empty", () => {
    setNYTime("2026-09-21T10:00:00"); // a Monday
    expect(isDayAvoided([])).toBe(false);
  });

  it("returns true when today matches an entry in day_avoidance", () => {
    setNYTime("2026-09-21T10:00:00"); // Monday, 2026-09-21
    expect(isDayAvoided(["MONDAY"])).toBe(true);
  });

  it("returns false when today does not match any entry", () => {
    setNYTime("2026-09-21T10:00:00"); // Monday
    expect(isDayAvoided(["FRIDAY"])).toBe(false);
  });
});
