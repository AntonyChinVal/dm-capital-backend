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

  return targetsDays.map((target) => {
    const closest = termStructure.reduce((best, p) =>
      Math.abs(p.tenorDays - target) < Math.abs(best.tenorDays - target) ? p : best,
    termStructure[0]);

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
