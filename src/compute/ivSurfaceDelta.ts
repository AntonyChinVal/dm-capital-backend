import { deltaB76 } from './black76.js';
import { interpolateIvAtDelta } from './skew.js';
import { fillSurfaceRowGaps } from './ivSurface.js';

/** Delta grid Q12-A: −0.50…−0.05 · gap ATM · +0.05…+0.50 (step 0.05). */
export const SURFACE_DELTA_GRID: number[] = (() => {
  const grid: number[] = [];
  for (let i = -50; i <= -5; i += 5) grid.push(i / 100);
  for (let i = 5; i <= 50; i += 5) grid.push(i / 100);
  return grid;
})();

export interface SurfaceDeltaInput {
  strike: number;
  type: 'C' | 'P';
  markIv: number;
  expiration: string;
  expirationTimestamp: number;
  underlyingPrice: number;
  interestRate?: number;
}

export interface SurfaceDeltaRow {
  expiration: string;
  expirationTimestamp: number;
  tenorDays: number;
  iv: Array<number | null>;
}

export interface SurfaceDelta {
  deltas: number[];
  rows: SurfaceDeltaRow[];
}

const MIN_ABS_DELTA = 0.05;

function tenorYears(expirationTimestamp: number, now: number): number {
  return Math.max(1 / (365 * 24 * 3600), (expirationTimestamp - now) / (365 * 24 * 3600 * 1000));
}

function deltaIvSeries(
  rows: SurfaceDeltaInput[],
  type: 'C' | 'P',
  F: number,
  T: number,
  r: number,
): Array<{ delta: number; iv: number }> {
  const series: Array<{ delta: number; iv: number }> = [];
  for (const row of rows) {
    if (row.type !== type || !row.markIv || row.markIv <= 0 || F <= 0 || T <= 0) continue;
    const delta = deltaB76(F, row.strike, T, row.markIv, r, type);
    if (Math.abs(delta) < MIN_ABS_DELTA) continue;
    series.push({ delta, iv: row.markIv });
  }
  series.sort((a, b) => a.delta - b.delta);
  return series;
}

/**
 * IV surface on a fixed delta grid per expiration (Black-76 delta interpolation).
 */
export function buildSurfaceByDelta(rows: SurfaceDeltaInput[], maxTenors = 8): SurfaceDelta {
  const byExp = new Map<string, { ts: number; rows: SurfaceDeltaInput[] }>();
  for (const r of rows) {
    let bucket = byExp.get(r.expiration);
    if (!bucket) {
      bucket = { ts: r.expirationTimestamp, rows: [] };
      byExp.set(r.expiration, bucket);
    }
    bucket.rows.push(r);
  }

  const sortedExp = [...byExp.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .slice(0, maxTenors);

  const now = Date.now();
  const deltas = SURFACE_DELTA_GRID;

  const surfaceRows: SurfaceDeltaRow[] = sortedExp.map(([expiration, bucket]) => {
    const F = bucket.rows.find((r) => r.underlyingPrice > 0)?.underlyingPrice ?? 0;
    const T = tenorYears(bucket.ts, now);
    const r = bucket.rows[0]?.interestRate ?? 0;
    const calls = deltaIvSeries(bucket.rows, 'C', F, T, r);
    const puts = deltaIvSeries(bucket.rows, 'P', F, T, r);

    const iv = deltas.map((target) => {
      if (target < 0) return interpolateIvAtDelta(puts, target);
      if (target > 0) return interpolateIvAtDelta(calls, target);
      return null;
    });
    fillSurfaceRowGaps(iv);

    return {
      expiration,
      expirationTimestamp: bucket.ts,
      tenorDays: Math.max(1, Math.round((bucket.ts - now) / 86400000)),
      iv,
    };
  });

  return { deltas, rows: surfaceRows };
}
