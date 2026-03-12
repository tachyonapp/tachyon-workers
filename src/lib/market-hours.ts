// Market Hours Guard
// =============================================================================
// PURPOSE
// =============================================================================
// This utility guards the `scan-dispatch` and `summary` worker processors against
// running outside NYSE trading hours. It uses `luxon` with the IANA
// `'America/New_York'` timezone for automatic EST/EDT handling. Market hours
// are Mon–Fri, 9:30 AM – 4:00 PM ET.
// =============================================================================
import { DateTime } from "luxon";

const MARKET_TIMEZONE = "America/New_York";

/**
 * Returns true if the current moment falls within NYSE trading hours:
 * Monday–Friday, 9:30 AM – 4:00 PM ET.
 * Luxon resolves 'America/New_York' via IANA timezone database —
 * EST/EDT transitions are handled automatically.
 */
export function isMarketHours(): boolean {
  const now = DateTime.now().setZone(MARKET_TIMEZONE);

  // Weekend check (1=Mon, 7=Sun in Luxon)
  if (now.weekday > 5) return false;

  const open = now.set({ hour: 9, minute: 30, second: 0, millisecond: 0 });
  const close = now.set({ hour: 16, minute: 0, second: 0, millisecond: 0 });

  return now >= open && now < close;
}
