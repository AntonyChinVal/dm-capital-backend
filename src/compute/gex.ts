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

export interface DexInput {
  strike: number;
  type: 'C' | 'P';
  openInterest: number;
  delta: number;
  /** Per-contract spot/forward multiplier; falls back to `defaultSpot`. */
  spot?: number;
}

export interface DEXPoint {
  strike: number;
  callDex: number;
  putDex: number;
  netDex: number;
}

export interface DexSummary {
  netDex: number;
  callLoadedStrike: number | null;
  putLoadedStrike: number | null;
}

export interface VexInput {
  strike: number;
  type: 'C' | 'P';
  openInterest: number;
  vanna: number;
  /** Per-contract spot/forward multiplier; falls back to `defaultSpot`. */
  spot?: number;
}

export interface VEXPoint {
  strike: number;
  callVex: number;
  putVex: number;
  netVex: number;
}

export interface VexSummary {
  netVex: number;
  positiveStrike: number | null;
  negativeStrike: number | null;
}

export interface ExposureInput {
  strike: number;
  type: 'C' | 'P';
  openInterest: number;
}

export interface StrikeExposurePoint {
  strike: number;
  callExposure: number;
  putExposure: number;
  netExposure: number;
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
 * Generic signed exposure by strike. GEX, DEX and later VEX share the same
 * grouping loop; each caller only changes the per-option weight.
 */
export function exposureByStrike<T extends ExposureInput>(
  rows: T[],
  weightFn: (row: T) => number,
): StrikeExposurePoint[] {
  const m = new Map<number, StrikeExposurePoint>();
  for (const r of rows) {
    if (r.openInterest <= 0) continue;
    const weight = weightFn(r);
    if (!Number.isFinite(weight) || weight === 0) continue;
    let pt = m.get(r.strike);
    if (!pt) {
      pt = { strike: r.strike, callExposure: 0, putExposure: 0, netExposure: 0 };
      m.set(r.strike, pt);
    }
    if (r.type === 'C') pt.callExposure += weight;
    else pt.putExposure += weight;
    pt.netExposure += weight;
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * GEX per strike (calls positive, puts negative).
 * Magnitude: gamma × OI × spot (per row or default).
 */
export function gexByStrike(rows: GexInput[], defaultSpot: number): GEXPoint[] {
  return exposureByStrike(rows, (r) => {
    const spot = r.spot ?? defaultSpot;
    const magnitude = r.gamma * r.openInterest * spot;
    return r.type === 'C' ? magnitude : -magnitude;
  }).map((p) => ({
    strike: p.strike,
    callGex: p.callExposure,
    putGex: Math.abs(p.putExposure),
    netGex: p.netExposure,
  }));
}

/**
 * DEX per strike (delta is already signed by option type).
 * Magnitude: delta × OI × spot, in USD delta notional.
 */
export function dexByStrike(rows: DexInput[], defaultSpot: number): DEXPoint[] {
  return exposureByStrike(rows, (r) => {
    const spot = r.spot ?? defaultSpot;
    return r.delta * r.openInterest * spot;
  }).map((p) => ({
    strike: p.strike,
    callDex: p.callExposure,
    putDex: p.putExposure,
    netDex: p.netExposure,
  }));
}

export function dexSummary(points: DEXPoint[]): DexSummary {
  const netDex = points.reduce((s, p) => s + p.netDex, 0);
  const callLoaded = points
    .filter((p) => p.callDex > 0)
    .reduce<DEXPoint | null>((best, p) => (best == null || p.callDex > best.callDex ? p : best), null);
  const putLoaded = points
    .filter((p) => p.putDex < 0)
    .reduce<DEXPoint | null>((best, p) => (best == null || p.putDex < best.putDex ? p : best), null);
  return {
    netDex,
    callLoadedStrike: callLoaded?.strike ?? null,
    putLoadedStrike: putLoaded?.strike ?? null,
  };
}

/**
 * VEX per strike (vanna is already mathematically signed).
 * VEX = delta-notional change per 1 point of IV.
 */
export function vexByStrike(rows: VexInput[], defaultSpot: number): VEXPoint[] {
  return exposureByStrike(rows, (r) => {
    const spot = r.spot ?? defaultSpot;
    return r.vanna * r.openInterest * spot;
  }).map((p) => ({
    strike: p.strike,
    callVex: p.callExposure,
    putVex: p.putExposure,
    netVex: p.netExposure,
  }));
}

export function vexSummary(points: VEXPoint[]): VexSummary {
  const netVex = points.reduce((s, p) => s + p.netVex, 0);
  const positive = points
    .filter((p) => p.netVex > 0)
    .reduce<VEXPoint | null>((best, p) => (best == null || p.netVex > best.netVex ? p : best), null);
  const negative = points
    .filter((p) => p.netVex < 0)
    .reduce<VEXPoint | null>((best, p) => (best == null || p.netVex < best.netVex ? p : best), null);
  return {
    netVex,
    positiveStrike: positive?.strike ?? null,
    negativeStrike: negative?.strike ?? null,
  };
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

/** Local resistance — max positive net GEX above ref price (per expiry). */
export function resistanceWall(points: GEXPoint[], refPrice: number): number | null {
  if (!points.length || refPrice <= 0) return null;
  const above = points.filter((p) => p.strike > refPrice && p.netGex > 0);
  if (!above.length) return null;
  const w = above.reduce((a, b) => (b.netGex > a.netGex ? b : a));
  return w.strike;
}

export interface PutSideWallOpts {
  putOiByStrike?: Map<number, number>;
  putVolumeByStrike?: Map<number, number>;
}

/**
 * Put-side wall below ref price: min net GEX (most negative γ−), tie-break higher put OI.
 * Requires put OI > 0 or put volume > 0 when liquidity maps are provided.
 */
export function putSideWall(
  points: GEXPoint[],
  refPrice: number,
  opts?: PutSideWallOpts,
): number | null {
  if (!points.length || refPrice <= 0) return null;

  const { putOiByStrike, putVolumeByStrike } = opts ?? {};
  const hasLiquidityMaps = putOiByStrike != null || putVolumeByStrike != null;

  const below = points.filter((p) => {
    if (p.strike >= refPrice) return false;
    if (!hasLiquidityMaps) return p.netGex < 0 || p.putGex > 0;
    const oi = putOiByStrike?.get(p.strike) ?? 0;
    const vol = putVolumeByStrike?.get(p.strike) ?? 0;
    return oi > 0 || vol > 0;
  });
  if (!below.length) return null;

  return below.reduce((a, b) => {
    if (a.netGex !== b.netGex) return a.netGex < b.netGex ? a : b;
    const oiA = putOiByStrike?.get(a.strike) ?? 0;
    const oiB = putOiByStrike?.get(b.strike) ?? 0;
    if (oiB !== oiA) return oiB > oiA ? b : a;
    return a.putGex > b.putGex ? a : b;
  }).strike;
}

/** Local support — put-side wall below ref price (per expiry). */
export function supportWall(
  points: GEXPoint[],
  refPrice: number,
  putOiByStrike?: Map<number, number>,
  putVolumeByStrike?: Map<number, number>,
): number | null {
  return putSideWall(points, refPrice, { putOiByStrike, putVolumeByStrike });
}

/** Structural call wall — max positive net GEX on the full book. */
export function structuralCallWall(points: GEXPoint[]): number | null {
  if (!points.length) return null;
  const positive = points.filter((p) => p.netGex > 0);
  if (!positive.length) return callWall(points);
  const w = positive.reduce((a, b) => (b.netGex > a.netGex ? b : a));
  return w.strike;
}

/** Structural put wall — min net GEX below index spot on the full book. */
export function structuralPutWall(
  points: GEXPoint[],
  refPrice: number,
  opts?: PutSideWallOpts,
): number | null {
  return putSideWall(points, refPrice, opts);
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
    putWall:
      spot != null
        ? putSideWall(points, spot)
        : putWall(points),
    netGex: totalNetGex(points),
  };
}
