export interface IvPoint {
  strike: number;
  iv: number;
}

interface IvInput {
  strike: number;
  markIv: number;
}

/**
 * IV curve: one IV value per strike, averaged across call+put when both quote.
 * Skips instruments with no/zero IV.
 */
export function ivCurve(rows: IvInput[]): IvPoint[] {
  const m = new Map<number, { sum: number; n: number }>();
  for (const r of rows) {
    if (!r.markIv || r.markIv <= 0) continue;
    let agg = m.get(r.strike);
    if (!agg) {
      agg = { sum: 0, n: 0 };
      m.set(r.strike, agg);
    }
    agg.sum += r.markIv;
    agg.n += 1;
  }
  return [...m.entries()]
    .map(([strike, { sum, n }]) => ({ strike, iv: sum / n }))
    .sort((a, b) => a.strike - b.strike);
}
