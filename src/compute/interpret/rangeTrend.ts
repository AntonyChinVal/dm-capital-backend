import { THRESHOLDS } from './thresholds.js';

export type RangeTrendState = 'range' | 'trend-up' | 'trend-down' | 'unknown';

/**
 * B9.2 algorithm: spot position between call and put walls.
 * Near the middle of the corridor → "range"; near a wall → "trend".
 */
export function classifyRangeTrend(
  spot: number | null,
  callWall: number | null,
  putWall: number | null,
): RangeTrendState {
  if (spot == null || callWall == null || putWall == null) return 'unknown';
  if (callWall <= putWall) return 'unknown'; // degenerate

  const total = callWall - putWall;
  const fromPut = spot - putWall;
  const ratio = fromPut / total;

  const { centralLow, centralHigh } = THRESHOLDS.rangeTrend;
  if (ratio > centralLow && ratio < centralHigh) return 'range';
  if (ratio <= centralLow) return 'trend-down';
  return 'trend-up';
}
