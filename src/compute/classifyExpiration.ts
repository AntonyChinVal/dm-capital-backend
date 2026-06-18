export type ExpirationTag = 'D' | 'W' | 'M' | 'Q';

const QUARTER_MONTHS = new Set([2, 5, 8, 11]); // Mar, Jun, Sep, Dec (UTC month index 0-11)

/**
 * Classify a Deribit expiration timestamp into D/W/M/Q based on calendar
 * position. All calendar attributes read in UTC — never local time —
 * because Deribit expires at 08:00 UTC and a local-time read can shift
 * the day-of-week or month at timezone boundaries (see ROADMAP B6.2).
 *
 *  D — daily / non-Friday (covers Sat/Sun expirations too)
 *  W — Friday but not the last of the month
 *  M — last Friday of a non-quarter month
 *  Q — last Friday of Mar/Jun/Sep/Dec (Q wins over M)
 */
export function classifyExpiration(ts: number): ExpirationTag {
  const d = new Date(ts);
  const dayOfWeek = d.getUTCDay();
  if (dayOfWeek !== 5) return 'D';

  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  const isLastFridayOfMonth = day > lastDayOfMonth - 7;
  if (!isLastFridayOfMonth) return 'W';

  return QUARTER_MONTHS.has(month) ? 'Q' : 'M';
}
