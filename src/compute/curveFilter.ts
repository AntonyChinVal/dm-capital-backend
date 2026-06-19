import { deltaB76 } from './black76.js';

export interface CurveFilterable {
  strike: number;
  type: 'C' | 'P';
  markIv: number;
  underlyingPrice: number;
  openInterest: number;
  volume?: number;
  expirationTimestamp: number;
  interestRate?: number;
}

export interface CurveFilterOptions {
  minDelta?: number;
  maxDelta?: number;
  /** IV cap floor — zero-volume nodes at/above this are discarded (Deribit wing garbage). */
  ivCapFloor?: number;
  now?: number;
}

const DEFAULT_MIN_DELTA = 0.05;
const DEFAULT_MAX_DELTA = 0.95;
const DEFAULT_IV_CAP = 125;

function tenorYears(expirationTimestamp: number, now: number): number {
  return Math.max(1 / (365 * 24 * 3600), (expirationTimestamp - now) / (365 * 24 * 3600 * 1000));
}

/**
 * Delta-band filter for IV smirk / 3D surface nodes.
 * Keeps strikes with |Δ| ∈ [0.05, 0.95] and activity (OI or volume).
 */
export function filterCurveStrikes<T extends CurveFilterable>(
  rows: T[],
  opts: CurveFilterOptions = {},
): T[] {
  const minD = opts.minDelta ?? DEFAULT_MIN_DELTA;
  const maxD = opts.maxDelta ?? DEFAULT_MAX_DELTA;
  const ivCap = opts.ivCapFloor ?? DEFAULT_IV_CAP;
  const now = opts.now ?? Date.now();

  return rows.filter((r) => {
    if (!r.markIv || r.markIv <= 0) return false;
    if (r.openInterest <= 0 && (r.volume ?? 0) <= 0) return false;

    const F = r.underlyingPrice;
    if (!F || F <= 0) return false;

    if ((r.volume ?? 0) <= 0 && r.markIv >= ivCap) return false;

    const T = tenorYears(r.expirationTimestamp, now);
    const delta = deltaB76(F, r.strike, T, r.markIv, r.interestRate ?? 0, r.type);
    const absD = Math.abs(delta);
    return absD >= minD && absD <= maxD;
  });
}
