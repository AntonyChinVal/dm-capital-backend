import { gammaB76 } from './black76.js';

export interface GEXPoint {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
}

export interface GexInput {
  strike: number;
  type: 'C' | 'P';
  openInterest: number;
  gamma: number;
  /** Per-contract spot/forward multiplier; falls back to `defaultSpot`. */
  spot?: number;
}

export interface GexSweepOption {
  strike: number;
  type: 'C' | 'P';
  openInterest: number;
  iv: number;
  tenorYears: number;
  r?: number;
}

export type Regime = 'positive' | 'negative' | 'unknown';

export interface RegimeReport {
  regime: Regime;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  netGex: number;
}

/**
 * GEX per strike (calls positive, puts negative).
 * Magnitude: gamma × OI × spot (per row or default).
 */
export function gexByStrike(rows: GexInput[], defaultSpot: number): GEXPoint[] {
  const m = new Map<number, GEXPoint>();
  for (const r of rows) {
    if (!Number.isFinite(r.gamma) || r.gamma === 0) continue;
    let pt = m.get(r.strike);
    if (!pt) {
      pt = { strike: r.strike, callGex: 0, putGex: 0, netGex: 0 };
      m.set(r.strike, pt);
    }
    const spot = r.spot ?? defaultSpot;
    const magnitude = r.gamma * r.openInterest * spot;
    if (r.type === 'C') {
      pt.callGex += magnitude;
      pt.netGex += magnitude;
    } else {
      pt.putGex += magnitude;
      pt.netGex -= magnitude;
    }
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

function netGexAtPrice(options: GexSweepOption[], F: number, r = 0): number {
  return options.reduce((acc, o) => {
    if (o.openInterest <= 0 || o.iv <= 0) return acc;
    const g = gammaB76(F, o.strike, o.tenorYears, o.iv, o.r ?? r);
    const magnitude = g * o.openInterest * F;
    return acc + (o.type === 'C' ? magnitude : -magnitude);
  }, 0);
}

/**
 * Gamma flip via price sweep (zero-gamma). Picks the crossing closest to refPrice.
 */
export function gammaFlipSweep(
  options: GexSweepOption[],
  refPrice: number,
  r = 0,
): number | null {
  if (!options.length || refPrice <= 0) return null;

  const step = Math.max(25, Math.round(refPrice * 0.0004));
  const lo = refPrice * 0.5;
  const hi = refPrice * 2;

  let prevF = lo;
  let prevV = netGexAtPrice(options, lo, r);
  const crossings: number[] = [];

  for (let F = lo + step; F <= hi; F += step) {
    const v = netGexAtPrice(options, F, r);
    if (prevV !== 0 && v !== 0 && (prevV < 0) !== (v < 0)) {
      const t = prevV / (prevV - v);
      crossings.push(prevF + t * (F - prevF));
    }
    prevF = F;
    prevV = v;
  }

  if (!crossings.length) return null;
  return crossings.sort((a, b) => Math.abs(a - refPrice) - Math.abs(b - refPrice))[0] ?? null;
}

/** @deprecated Legacy strike-cumulative crossing — use gammaFlipSweep. */
export function gammaFlip(points: GEXPoint[]): number | null {
  if (!points.length) return null;
  let cum = 0;
  let prevCum = 0;
  let crossing: number | null = null;
  for (const p of points) {
    prevCum = cum;
    cum += p.netGex;
    if ((prevCum < 0 && cum >= 0) || (prevCum > 0 && cum <= 0)) {
      crossing = p.strike;
      break;
    }
  }
  if (crossing != null) return crossing;
  return points.reduce((a, b) => (Math.abs(b.netGex) < Math.abs(a.netGex) ? b : a)).strike;
}

export function callWall(points: GEXPoint[]): number | null {
  if (!points.length) return null;
  const w = points.reduce((a, b) => (b.callGex > a.callGex ? b : a));
  return w.callGex > 0 ? w.strike : null;
}

export function putWall(points: GEXPoint[]): number | null {
  if (!points.length) return null;
  const w = points.reduce((a, b) => (b.putGex > a.putGex ? b : a));
  return w.putGex > 0 ? w.strike : null;
}

export function totalNetGex(points: GEXPoint[]): number {
  return points.reduce((s, p) => s + p.netGex, 0);
}

export function regimeReport(
  points: GEXPoint[],
  spot: number | null,
  sweepOptions?: GexSweepOption[],
): RegimeReport {
  const flip =
    sweepOptions?.length && spot != null
      ? gammaFlipSweep(sweepOptions, spot)
      : gammaFlip(points);

  let regime: Regime = 'unknown';
  if (flip != null && spot != null) {
    regime = spot >= flip ? 'positive' : 'negative';
  }

  return {
    regime,
    gammaFlip: flip,
    callWall: callWall(points),
    putWall: putWall(points),
    netGex: totalNetGex(points),
  };
}
