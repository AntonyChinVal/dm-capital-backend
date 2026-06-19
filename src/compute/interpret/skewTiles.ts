import { THRESHOLDS } from './thresholds.js';

export interface SkewTile {
  targetDays: number;
  actualDays: number;
  expiration: string;
  skew25d: number | null;
  label: string;
}

interface TermPoint {
  expiration: string;
  tenorDays: number;
  skew25d: number | null;
}

/**
 * B9.3 algorithm: for each target tenor pick the closest available
 * expiration. If the actual deviation > threshold, label includes the
 * actual days so Hernán knows the tile is approximate.
 */
export function pickSkewTiles(termStructure: TermPoint[]): SkewTile[] {
  const { targetsDays, deviationLabelThreshold } = THRESHOLDS.skewTiles;
  if (!termStructure.length) {
    return targetsDays.map((t) => ({
      targetDays: t,
      actualDays: 0,
      expiration: '—',
      skew25d: null,
      label: `${t}d`,
    }));
  }

  const used = new Set<string>();

  return targetsDays.map((target) => {
    const pool = termStructure.filter((p) => !used.has(p.expiration));
    const source = pool.length ? pool : termStructure;
    const closest = source.reduce((best, p) =>
      Math.abs(p.tenorDays - target) < Math.abs(best.tenorDays - target) ? p : best,
    source[0]);
    used.add(closest.expiration);

    const deviation = Math.abs(closest.tenorDays - target) / target;
    const label = deviation > deviationLabelThreshold
      ? `${target}d (≈${closest.tenorDays}d)`
      : `${target}d`;

    return {
      targetDays: target,
      actualDays: closest.tenorDays,
      expiration: closest.expiration,
      skew25d: closest.skew25d,
      label,
    };
  });
}

/** Headline skew — same 7D tenor as the first SkewTile (rigorous 25Δ). */
export function pickHeadlineSkew(termStructure: TermPoint[]): number | null {
  return pickSkewTileForTarget(termStructure, 7);
}

/** Secondary header skew — 30D tenor for intraday vs regime comparison. */
export function pickHeadlineSkew30d(termStructure: TermPoint[]): number | null {
  return pickSkewTileForTarget(termStructure, 30);
}

function pickSkewTileForTarget(termStructure: TermPoint[], targetDays: number): number | null {
  const tile = pickSkewTiles(termStructure).find((t) => t.targetDays === targetDays);
  return tile?.skew25d ?? null;
}
