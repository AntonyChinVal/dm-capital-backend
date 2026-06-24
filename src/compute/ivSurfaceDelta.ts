import { deltaB76 } from './black76.js';
import { interpolateIvAtDelta } from './skew.js';

/** Put wing targets: OTM (−0.05) → ATM side (−0.50). */
const PUT_WING_DELTAS = [-0.05, -0.1, -0.15, -0.2, -0.25, -0.3, -0.35, -0.4, -0.45, -0.5] as const;
/** Call wing targets: ATM side (+0.50) → OTM (+0.05). */
const CALL_WING_DELTAS = [0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05] as const;

export interface DeltaColumn {
  index: number;
  rawDelta: number | null;
  label: string;
  hoverLabel: string;
}

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
  columns: DeltaColumn[];
  rows: SurfaceDeltaRow[];
}

const MIN_ABS_DELTA = 0.05;

function tenorYears(expirationTimestamp: number, now: number): number {
  return Math.max(1 / (365 * 24 * 3600), (expirationTimestamp - now) / (365 * 24 * 3600 * 1000));
}

function formatRawDelta(delta: number): string {
  const abs = Math.abs(delta).toFixed(2);
  if (delta < 0) return `δ −${abs}`;
  if (delta > 0) return `δ +${abs}`;
  return 'δ 0.00';
}

function buildDeltaColumns(): DeltaColumn[] {
  const cols: DeltaColumn[] = [];
  let idx = 0;

  for (const d of PUT_WING_DELTAS) {
    const label = `${Math.round(Math.abs(d) * 100)}Δ put`;
    cols.push({ index: idx++, rawDelta: d, label, hoverLabel: `${label} (${formatRawDelta(d)})` });
  }

  cols.push({ index: idx++, rawDelta: null, label: 'ATM', hoverLabel: 'ATM' });

  for (const d of CALL_WING_DELTAS) {
    const label = `${Math.round(d * 100)}Δ call`;
    cols.push({ index: idx++, rawDelta: d, label, hoverLabel: `${label} (${formatRawDelta(d)})` });
  }

  return cols;
}

export const SURFACE_DELTA_COLUMNS = buildDeltaColumns();

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

function avgIv(a: number | null, b: number | null): number | null {
  if (a != null && b != null) return (a + b) / 2;
  if (a != null) return a;
  if (b != null) return b;
  return null;
}

/**
 * IV surface on a fixed moneyness-ordered delta grid per expiration (Black-76).
 * 21 columns: 10 put wing · ATM · 10 call wing. No gap-fill — nulls stay masked.
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
  const columns = SURFACE_DELTA_COLUMNS;

  const surfaceRows: SurfaceDeltaRow[] = sortedExp.map(([expiration, bucket]) => {
    const F = bucket.rows.find((r) => r.underlyingPrice > 0)?.underlyingPrice ?? 0;
    const T = tenorYears(bucket.ts, now);
    const r = bucket.rows[0]?.interestRate ?? 0;
    const calls = deltaIvSeries(bucket.rows, 'C', F, T, r);
    const puts = deltaIvSeries(bucket.rows, 'P', F, T, r);

    const putWing = PUT_WING_DELTAS.map((target) => interpolateIvAtDelta(puts, target));
    const atmPut = interpolateIvAtDelta(puts, -0.5);
    const atmCall = interpolateIvAtDelta(calls, 0.5);
    const atm = avgIv(atmPut, atmCall);
    const callWing = CALL_WING_DELTAS.map((target) => interpolateIvAtDelta(calls, target));

    const iv = [...putWing, atm, ...callWing].map((v) =>
      v == null || !Number.isFinite(v) || v <= 0 ? null : v,
    );

    return {
      expiration,
      expirationTimestamp: bucket.ts,
      tenorDays: Math.max(1, Math.round((bucket.ts - now) / 86400000)),
      iv,
    };
  });

  return { columns, rows: surfaceRows };
}
