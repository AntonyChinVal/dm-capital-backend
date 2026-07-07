import { deltaB76 } from './black76.js';
import { filterCurveStrikes } from './curveFilter.js';
import { filterLiquidStrikes } from './liquidStrikes.js';
import type { ParsedOptionRow } from './metricsBundle.js';
import { interpolateIvAtDelta } from './skew.js';

export type IvGridDeltaKey = '-10' | '-20' | '-35' | 'ATM' | '35' | '20' | '10';
export type IvGridTenorKey = '7D' | '30D' | '90D' | '180D';

export type IvGridDeltaPoint = Partial<Record<IvGridDeltaKey, number | null>>;
export type IvGridByDelta = Partial<Record<IvGridTenorKey, IvGridDeltaPoint | null>>;

const CONSTANT_TENORS = [7, 30, 90, 180] as const;
const TENOR_LABEL: Record<(typeof CONSTANT_TENORS)[number], IvGridTenorKey> = {
  7: '7D',
  30: '30D',
  90: '90D',
  180: '180D',
};

const DELTA_SPECS: Array<{ key: IvGridDeltaKey; kind: 'put' | 'call' | 'atm'; target?: number }> = [
  { key: '-10', kind: 'put', target: -0.1 },
  { key: '-20', kind: 'put', target: -0.2 },
  { key: '-35', kind: 'put', target: -0.35 },
  { key: 'ATM', kind: 'atm' },
  { key: '35', kind: 'call', target: 0.35 },
  { key: '20', kind: 'call', target: 0.2 },
  { key: '10', kind: 'call', target: 0.1 },
];

const MIN_ABS_DELTA = 0.05;

function tenorYears(expirationTimestamp: number, now: number): number {
  return Math.max(1 / (365 * 24 * 3600), (expirationTimestamp - now) / (365 * 24 * 3600 * 1000));
}

function finiteIv(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function deltaIvSeries(
  rows: ParsedOptionRow[],
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

function ivPointAtSpec(
  puts: Array<{ delta: number; iv: number }>,
  calls: Array<{ delta: number; iv: number }>,
  spec: (typeof DELTA_SPECS)[number],
): number | null {
  if (spec.kind === 'atm') {
    const putIv = interpolateIvAtDelta(puts, -0.5);
    const callIv = interpolateIvAtDelta(calls, 0.5);
    if (putIv != null && callIv != null) return finiteIv((putIv + callIv) / 2);
    return finiteIv(putIv ?? callIv);
  }
  const series = spec.kind === 'put' ? puts : calls;
  return finiteIv(interpolateIvAtDelta(series, spec.target!));
}

function ivGridForExpiration(rows: ParsedOptionRow[], now: number): IvGridDeltaPoint {
  const F = rows.find((r) => r.underlyingPrice > 0)?.underlyingPrice ?? 0;
  const ts = rows[0]?.expirationTimestamp ?? now;
  const T = tenorYears(ts, now);
  const r = rows[0]?.interestRate ?? 0;
  const puts = deltaIvSeries(rows, 'P', F, T, r);
  const calls = deltaIvSeries(rows, 'C', F, T, r);

  const point: IvGridDeltaPoint = {};
  for (const spec of DELTA_SPECS) {
    const iv = ivPointAtSpec(puts, calls, spec);
    if (iv != null) point[spec.key] = iv;
  }
  return point;
}

function interpolateIvByTenor(
  points: Array<{ tenorDays: number; iv: number }>,
  target: number,
): number | null {
  if (!points.length) return null;

  const sorted = [...points].sort((a, b) => a.tenorDays - b.tenorDays);
  const exact = sorted.find((p) => p.tenorDays === target);
  if (exact) return exact.iv;

  const before = [...sorted].reverse().find((p) => p.tenorDays < target);
  const after = sorted.find((p) => p.tenorDays > target);
  if (!before || !after || after.tenorDays === before.tenorDays) return null;

  const t = (target - before.tenorDays) / (after.tenorDays - before.tenorDays);
  return finiteIv(before.iv + (after.iv - before.iv) * t);
}

function buildExpirationGrids(allRows: ParsedOptionRow[], now: number) {
  const curveLiquid = filterCurveStrikes(filterLiquidStrikes(allRows), { now });
  const byExp = new Map<string, { ts: number; rows: ParsedOptionRow[] }>();
  for (const r of curveLiquid) {
    let bucket = byExp.get(r.expiration);
    if (!bucket) {
      bucket = { ts: r.expirationTimestamp, rows: [] };
      byExp.set(r.expiration, bucket);
    }
    bucket.rows.push(r);
  }

  return [...byExp.entries()]
    .filter(([, bucket]) => {
      const tenorDays = Math.max(1, Math.round((bucket.ts - now) / 86_400_000));
      return tenorDays > 1;
    })
    .map(([, bucket]) => ({
      tenorDays: Math.max(1, Math.round((bucket.ts - now) / 86_400_000)),
      ivGrid: ivGridForExpiration(bucket.rows, now),
    }));
}

/**
 * IV surface on constant tenors (7D/30D/90D/180D) × 7 delta points.
 * Values in vol % (Deribit mark_iv). Missing points omitted — never 0.
 */
export function buildIvGridByConstantTenor(allRows: ParsedOptionRow[], now = Date.now()): IvGridByDelta | null {
  const expGrids = buildExpirationGrids(allRows, now);
  if (!expGrids.length) return null;

  const result: IvGridByDelta = {};

  for (const tenor of CONSTANT_TENORS) {
    const tenorKey = TENOR_LABEL[tenor];
    const deltaPoint: IvGridDeltaPoint = {};
    let hasAny = false;

    for (const spec of DELTA_SPECS) {
      const tenorIvPoints = expGrids
        .map((eg) => {
          const iv = eg.ivGrid[spec.key];
          return iv != null && Number.isFinite(iv) ? { tenorDays: eg.tenorDays, iv } : null;
        })
        .filter((p): p is { tenorDays: number; iv: number } => p != null);

      const interpolated = interpolateIvByTenor(tenorIvPoints, tenor);
      if (interpolated != null) {
        deltaPoint[spec.key] = interpolated;
        hasAny = true;
      }
    }

    result[tenorKey] = hasAny ? deltaPoint : null;
  }

  const anyTenor = Object.values(result).some((t) => t != null && Object.keys(t).length > 0);
  return anyTenor ? result : null;
}
