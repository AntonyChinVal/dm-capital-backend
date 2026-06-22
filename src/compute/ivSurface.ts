import { ivCurve } from './iv.js';

interface SurfaceInput {
  instrument: string;
  strike: number;
  type: 'C' | 'P';
  markIv: number;
  expiration: string;
  expirationTimestamp: number;
}

export interface SurfaceRow {
  expiration: string;
  expirationTimestamp: number;
  tenorDays: number;
  iv: Array<number | null>;
}

export interface Surface {
  strikes: number[];
  rows: SurfaceRow[];
}

/**
 * Build a strike × expiration IV matrix.
 * Strike axis = strikes that appear in at least `minCoverage` expirations,
 * filling missing cells via linear interpolation within each tenor row.
 */
export function buildSurface(rows: SurfaceInput[], maxTenors = 6, minCoverage = 2): Surface {
  const byExp = new Map<string, { ts: number; rows: SurfaceInput[] }>();
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

  const strikeFreq = new Map<number, number>();
  for (const [, bucket] of sortedExp) {
    const seen = new Set<number>();
    for (const r of bucket.rows) {
      if (!r.markIv || r.markIv <= 0) continue;
      seen.add(r.strike);
    }
    for (const s of seen) strikeFreq.set(s, (strikeFreq.get(s) ?? 0) + 1);
  }

  const strikes = [...strikeFreq.entries()]
    .filter(([, n]) => n >= minCoverage)
    .map(([s]) => s)
    .sort((a, b) => a - b);

  const now = Date.now();
  const surfaceRows: SurfaceRow[] = sortedExp.map(([expiration, bucket]) => {
    const curve = ivCurve(bucket.rows);
    const map = new Map(curve.map((p) => [p.strike, p.iv]));
    const iv: Array<number | null> = strikes.map((s) => map.get(s) ?? null);
    fillByLinearInterp(iv);
    return {
      expiration,
      expirationTimestamp: bucket.ts,
      tenorDays: Math.max(1, Math.round((bucket.ts - now) / 86400000)),
      iv,
    };
  });

  return { strikes, rows: surfaceRows };
}

/** Fill interior nulls on a surface row via linear interpolation. */
export function fillSurfaceRowGaps(arr: Array<number | null>): void {
  fillByLinearInterp(arr);
}

function fillByLinearInterp(arr: Array<number | null>): void {
  let i = 0;
  while (i < arr.length) {
    if (arr[i] != null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < arr.length && arr[j] == null) j++;
    if (i > 0 && j < arr.length && arr[i - 1] != null && arr[j] != null) {
      const left = arr[i - 1] as number;
      const right = arr[j] as number;
      const span = j - (i - 1);
      for (let k = i; k < j; k++) {
        const t = (k - (i - 1)) / span;
        arr[k] = left + (right - left) * t;
      }
    }
    i = j;
  }
}
