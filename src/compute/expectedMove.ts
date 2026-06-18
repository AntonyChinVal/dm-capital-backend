/**
 * Expected Move via the standard practitioner formula (B7.2 + B7.3 in ROADMAP).
 *
 *   EM(t) = spot × (atmIvPercent / 100) × √(t / 365)
 *
 * - 365 calendar days: BTC trades 24/7, DVOL is built on 365, no rationale
 *   for the equity-style 252.
 * - `atmIvPercent` is Deribit's `mark_iv` format (42.59 = 42.59%). The
 *   `/100` happens here, never at the storage layer.
 *
 * Returns 1σ — multiply by 2 for the 2σ band (98% probability range).
 */
const YEAR_DAYS = 365;

function safeNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function expectedMove(
  spot: number,
  atmIvPercent: number,
  daysToExpiry: number,
): number {
  if (!safeNumber(spot) || spot <= 0) return 0;
  if (!safeNumber(atmIvPercent) || atmIvPercent <= 0) return 0;
  if (!safeNumber(daysToExpiry) || daysToExpiry <= 0) return 0;
  const sigma = atmIvPercent / 100;
  const t = daysToExpiry / YEAR_DAYS;
  return spot * sigma * Math.sqrt(t);
}

export function expectedMoveDay(spot: number, atmIvPercent: number): number {
  return expectedMove(spot, atmIvPercent, 1);
}

export function expectedMoveToExpiration(
  spot: number,
  atmIvPercent: number,
  expirationMs: number,
  nowMs = Date.now(),
): number {
  const daysToExpiry = (expirationMs - nowMs) / 86_400_000;
  return expectedMove(spot, atmIvPercent, daysToExpiry);
}

export interface ExpectedMoveBands {
  spot: number;
  atmIv: number;          // % (Deribit format, callers display directly)
  daysToExpiry: number;
  sigma1: number;         // USD width of one std dev
  sigma2: number;         // USD width of two std devs
}

export function expectedMoveBands(
  spot: number,
  atmIvPercent: number,
  daysToExpiry: number,
): ExpectedMoveBands | null {
  const sigma1 = expectedMove(spot, atmIvPercent, daysToExpiry);
  if (sigma1 === 0) return null;
  return {
    spot,
    atmIv: atmIvPercent,
    daysToExpiry,
    sigma1,
    sigma2: sigma1 * 2,
  };
}
