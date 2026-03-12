import { DateTime, Settings } from "luxon";
import { isMarketHours } from "../market-hours";

describe("isMarketHours", () => {
  afterEach(() => {
    Settings.now = () => Date.now(); // restore
  });

  // Helper: create a fixed UTC timestamp for a given NY local time
  function setNYTime(isoLocalString: string) {
    const dt = DateTime.fromISO(isoLocalString, { zone: "America/New_York" });
    Settings.now = () => dt.toMillis();
  }

  it("returns true during market hours on a weekday (EST)", () => {
    setNYTime("2025-01-15T10:00:00"); // Wednesday, 10:00 AM EST
    expect(isMarketHours()).toBe(true);
  });

  it("returns true during market hours on a weekday (EDT)", () => {
    setNYTime("2025-07-15T10:00:00"); // Tuesday, 10:00 AM EDT
    expect(isMarketHours()).toBe(true);
  });

  it("returns false before market open (9:29 AM ET)", () => {
    setNYTime("2025-01-15T09:29:59");
    expect(isMarketHours()).toBe(false);
  });

  it("returns true at market open (9:30 AM ET)", () => {
    setNYTime("2025-01-15T09:30:00");
    expect(isMarketHours()).toBe(true);
  });

  it("returns false at market close (4:00 PM ET)", () => {
    setNYTime("2025-01-15T16:00:00");
    expect(isMarketHours()).toBe(false);
  });

  it("returns true at 3:59 PM ET (one minute before close)", () => {
    setNYTime("2025-01-15T15:59:00");
    expect(isMarketHours()).toBe(true);
  });

  it("returns false on Saturday", () => {
    setNYTime("2025-01-18T11:00:00"); // Saturday
    expect(isMarketHours()).toBe(false);
  });

  it("returns false on Sunday", () => {
    setNYTime("2025-01-19T11:00:00"); // Sunday
    expect(isMarketHours()).toBe(false);
  });

  it("handles EST to EDT transition (March, spring forward)", () => {
    setNYTime("2025-03-10T10:00:00"); // EDT in effect
    expect(isMarketHours()).toBe(true);
  });

  it("handles EDT to EST transition (November, fall back)", () => {
    setNYTime("2025-11-03T10:00:00"); // EST in effect after fall back
    expect(isMarketHours()).toBe(true);
  });
});
