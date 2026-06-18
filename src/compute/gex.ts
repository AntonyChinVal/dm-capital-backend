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
}

export type Regime = 'positive' | 'negative' | 'unknown';

export interface RegimeReport {
  regime: Regime;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
}

/**
 * GEX per strike (calls positive, puts negative).
 * Magnitude convention: gamma × OI × spot (BTC-equivalent USD per 1% move).
 */
export function gexByStrike(rows: GexInput[], spot: number): GEXPoint[] {
  const m = new Map<number, GEXPoint>();
  for (const r of rows) {
    if (!Number.isFinite(r.gamma) || r.gamma === 0) continue;
    let pt = m.get(r.strike);
    if (!pt) {
      pt = { strike: r.strike, callGex: 0, putGex: 0, netGex: 0 };
      m.set(r.strike, pt);
    }
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

/**
 * Gamma flip: the strike at which cumulative net GEX (low → high) crosses zero.
 * If no clean crossing, returns the strike with smallest |netGex| (closest to flat).
 */
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

/** Call wall: strike with the largest positive call GEX (biggest resistance). */
export function callWall(points: GEXPoint[]): number | null {
  if (!points.length) return null;
  const w = points.reduce((a, b) => (b.callGex > a.callGex ? b : a));
  return w.callGex > 0 ? w.strike : null;
}

/** Put wall: strike with the largest put GEX (biggest support). */
export function putWall(points: GEXPoint[]): number | null {
  if (!points.length) return null;
  const w = points.reduce((a, b) => (b.putGex > a.putGex ? b : a));
  return w.putGex > 0 ? w.strike : null;
}

export function regimeReport(points: GEXPoint[], spot: number | null): RegimeReport {
  const flip = gammaFlip(points);
  let regime: Regime = 'unknown';
  if (flip != null && spot != null) {
    regime = spot >= flip ? 'positive' : 'negative';
  }
  return {
    regime,
    gammaFlip: flip,
    callWall: callWall(points),
    putWall: putWall(points),
  };
}
