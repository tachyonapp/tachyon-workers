/**
 * Session Preference Narrowing
 *
 * Pure, time-based checks for bot_settings.session_preference and
 * .day_avoidance — whether the current moment falls inside an agent's
 * preferred trading window. This is an agent-preference narrowing,
 * not a staleness-gate audit event: a day/session exclusion must produce
 * NO scan_audit_log row, unlike every staleness-gate
 * outcome (see scan-bot.worker.ts Step 5, kept deliberately separate from the
 * audit-writing staleness path in Step 6/7).
 *
 * Session windows:
 *   FULL_SESSION      9:30 AM – 4:00 PM ET
 *   MORNING_HUNTER     9:30 AM – 12:00 PM ET
 *   AFTERNOON_HUNTER  12:00 PM – 4:00 PM ET
 *   AVOID_FIRST_30    10:00 AM – 4:00 PM ET (skips the first 30 min after open)
 */
import { DateTime } from "luxon";

const MARKET_TIMEZONE = "America/New_York";

const OPEN_MINUTES = 9 * 60 + 30;
const MIDDAY_MINUTES = 12 * 60;
const CLOSE_MINUTES = 16 * 60;
const AFTER_FIRST_30_MINUTES = 10 * 60;

function minutesSinceMidnight(dt: DateTime): number {
  return dt.hour * 60 + dt.minute;
}

/**
 * True if the current ET time falls inside the agent's session preference.
 * scan-bot.worker.ts does not itself re-check the 9:30–4:00 base market-hours
 * window — scan-dispatch already guards the entire fan-out (see that file's
 * header) — so FULL_SESSION and an unset preference both apply no narrowing here.
 */
export function isWithinSessionPreference(
  sessionPreference: string | null,
): boolean {
  const time = minutesSinceMidnight(DateTime.now().setZone(MARKET_TIMEZONE));

  switch (sessionPreference) {
    case "MORNING_HUNTER":
      return time >= OPEN_MINUTES && time < MIDDAY_MINUTES;
    case "AFTERNOON_HUNTER":
      return time >= MIDDAY_MINUTES && time < CLOSE_MINUTES;
    case "AVOID_FIRST_30":
      return time >= AFTER_FIRST_30_MINUTES && time < CLOSE_MINUTES;
    case "FULL_SESSION":
    default:
      return true;
  }
}

const WEEKDAY_NAMES = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

/** True if today (ET) is in the agent's day_avoidance list. */
export function isDayAvoided(dayAvoidance: string[]): boolean {
  if (dayAvoidance.length === 0) return false;
  const now = DateTime.now().setZone(MARKET_TIMEZONE);
  const today = WEEKDAY_NAMES[now.weekday - 1];
  return dayAvoidance.includes(today);
}
