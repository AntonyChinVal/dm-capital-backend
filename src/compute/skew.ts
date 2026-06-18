import { deltaB76 } from './black76.js';

export interface SkewInput {
  strike: number;
  type: 'C' | 'P';
  markIv: number;
  forward: number;
  tenorYears: number;
  r?: number;
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

function ivAtDelta(
  series: Array<{ delta: number; iv: number }>,
  target: number,
): number | null {
  if (series.length < 2) return null;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    if ((a.delta - target) * (b.delta - target) <= 0 && b.delta !== a.delta) {
      const t = (target - a.delta) / (b.delta - a.delta);
      return a.iv + (b.iv - a.iv) * t;
    }
  }
  return null;
}

/**
 * 25Δ skew = IV(put 25Δ) − IV(call 25Δ), interpolated on forward delta (Black-76).
 */
export function skew25d(rows: SkewInput[]): SkewResult {
  const calls: Array<{ delta: number; iv: number; strike: number }> = [];
  const puts: Array<{ delta: number; iv: number; strike: number }> = [];

  for (const r of rows) {
    if (!r.markIv || r.markIv <= 0 || r.forward <= 0 || r.tenorYears <= 0) continue;
    const rRate = r.r ?? 0;
    const d = deltaB76(r.forward, r.strike, r.tenorYears, r.markIv, rRate, r.type);
    const bucket = r.type === 'C' ? calls : puts;
    bucket.push({ delta: d, iv: r.markIv, strike: r.strike });
  }

  calls.sort((a, b) => a.delta - b.delta);
  puts.sort((a, b) => a.delta - b.delta);

  const callIv = ivAtDelta(calls, 0.25);
  const putIv = ivAtDelta(puts, -0.25);
  if (callIv == null || putIv == null) return { skew25d: null };

  return {
    skew25d: putIv - callIv,
    callIv,
    putIv,
    callDelta: 0.25,
    putDelta: -0.25,
  };
}
