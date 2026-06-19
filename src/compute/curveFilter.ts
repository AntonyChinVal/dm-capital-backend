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
  /** Minimum OI (BTC contracts) to keep a strike outside the delta band. */
  minOi?: number;
  /** Stricter OI floor for nodes outside |Δ| band (salvage path). */
  outOfBandMinOi?: number;
  /** IV cap floor — zero-volume nodes at/above this are discarded (Deribit wing garbage). */
  ivCapFloor?: number;
  now?: number;
}

const DEFAULT_MIN_DELTA = 0.05;
const DEFAULT_MAX_DELTA = 0.95;
const DEFAULT_IV_CAP = 125;
const DEFAULT_MIN_OI = 1;
const DEFAULT_OUT_OF_BAND_MIN_OI = 10;

function tenorYears(expirationTimestamp: number, now: number): number {
  return Math.max(1 / (365 * 24 * 3600), (expirationTimestamp - now) / (365 * 24 * 3600 * 1000));
}

/**
 * Delta-band filter for IV smirk / 3D surface nodes.
 * Keeps strikes in |Δ| band OR with real liquidity (OI/volume floor).
 */
export function filterCurveStrikes<T extends CurveFilterable>(
  rows: T[],
  opts: CurveFilterOptions = {},
): T[] {
  const minD = opts.minDelta ?? DEFAULT_MIN_DELTA;
  const maxD = opts.maxDelta ?? DEFAULT_MAX_DELTA;
  const ivCap = opts.ivCapFloor ?? DEFAULT_IV_CAP;
  const outMinOi = opts.outOfBandMinOi ?? DEFAULT_OUT_OF_BAND_MIN_OI;
  const now = opts.now ?? Date.now();

  return rows.filter((r) => {
    if (!r.markIv || r.markIv <= 0) return false;

    const F = r.underlyingPrice;
    if (!F || F <= 0) return false;

    if ((r.volume ?? 0) <= 0 && r.markIv >= ivCap) return false;

    const T = tenorYears(r.expirationTimestamp, now);
    const delta = deltaB76(F, r.strike, T, r.markIv, r.interestRate ?? 0, r.type);
    const absD = Math.abs(delta);
    const inBand = absD >= minD && absD <= maxD;
    if (inBand) return true;

    // Salvage path — short tenors only (dailies / near-weeklies).
    const tenorDays = (r.expirationTimestamp - now) / 86_400_000;
    if (tenorDays > 7) return false;

    if (r.markIv >= ivCap) return false;
    const moneyness = r.strike / F;
    if (moneyness < 0.4 || moneyness > 2.0) return false;
    return r.openInterest >= outMinOi || (r.volume ?? 0) > 0;
  });
}
