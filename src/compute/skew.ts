import { getGreeks } from '../state/greeks.js';

interface SkewInput {
  instrument: string;
  strike: number;
  type: 'C' | 'P';
  markIv: number;
}

export interface SkewResult {
  skew25d: number | null;
  callIv?: number;
  putIv?: number;
  callDelta?: number;
  putDelta?: number;
  callStrike?: number;
  putStrike?: number;
}

/**
 * 25-delta skew = IV(25Δ Put) − IV(25Δ Call).
 * Picks the call with delta closest to +0.25 and the put closest to −0.25
 * using the live delta from the WS-fed greeks store.
 */
export function skew25d(rows: SkewInput[]): SkewResult {
  let bestCall: { iv: number; delta: number; strike: number } | null = null;
  let bestPut: { iv: number; delta: number; strike: number } | null = null;

  for (const r of rows) {
    if (!r.markIv || r.markIv <= 0) continue;
    const g = getGreeks(r.instrument);
    if (g?.delta == null || !Number.isFinite(g.delta)) continue;

    if (r.type === 'C') {
      const dist = Math.abs(g.delta - 0.25);
      if (!bestCall || dist < Math.abs(bestCall.delta - 0.25)) {
        bestCall = { iv: r.markIv, delta: g.delta, strike: r.strike };
      }
    } else {
      const dist = Math.abs(g.delta + 0.25);
      if (!bestPut || dist < Math.abs(bestPut.delta + 0.25)) {
        bestPut = { iv: r.markIv, delta: g.delta, strike: r.strike };
      }
    }
  }

  if (!bestCall || !bestPut) return { skew25d: null };
  return {
    skew25d: bestPut.iv - bestCall.iv,
    callIv: bestCall.iv,
    putIv: bestPut.iv,
    callDelta: bestCall.delta,
    putDelta: bestPut.delta,
    callStrike: bestCall.strike,
    putStrike: bestPut.strike,
  };
}
