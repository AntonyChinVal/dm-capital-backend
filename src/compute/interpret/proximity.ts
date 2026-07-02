import { THRESHOLDS } from './thresholds.js';

export function sigmaDistance(spot: number, level: number, em1sigma: number): number {
  if (!Number.isFinite(em1sigma) || em1sigma <= 0) return Infinity;
  return (spot - level) / em1sigma;
}

/**
 * Descriptive proximity copy in units of daily expected move (1σ).
 * <0.5σ "at" · 0.5–1.5σ "near" · >1.5σ show the number.
 */
export function proximityCopy(
  spot: number,
  level: number,
  em1sigma: number,
  label: string,
): string {
  const sigma = sigmaDistance(spot, level, em1sigma);
  const absSigma = Math.abs(sigma);
  const { at, near } = THRESHOLDS.proximity;

  if (!Number.isFinite(absSigma)) {
    return `Spot relative to the ${label}.`;
  }
  if (absSigma < at) {
    return `Spot at the ${label}.`;
  }
  if (absSigma < near) {
    return `Spot near the ${label} (${absSigma.toFixed(1)}σ).`;
  }
  const dir = sigma > 0 ? 'above' : 'below';
  return `Spot ${absSigma.toFixed(1)}σ ${dir} the ${label}.`;
}

/** Call-wall side: above ≠ near when spot is past the wall. */
export function callWallProximityCopy(
  spot: number,
  callWall: number,
  em1sigma: number,
): string {
  if (spot > callWall) {
    const sigma = sigmaDistance(spot, callWall, em1sigma);
    if (Number.isFinite(sigma) && sigma >= THRESHOLDS.proximity.near) {
      return `Spot ${sigma.toFixed(1)}σ above the call wall.`;
    }
    return 'Spot above the call wall.';
  }
  return proximityCopy(spot, callWall, em1sigma, 'call wall');
}

/** Put-wall side: below ≠ near when spot is past the wall. */
export function putWallProximityCopy(
  spot: number,
  putWall: number,
  em1sigma: number,
): string {
  if (spot < putWall) {
    const sigma = sigmaDistance(putWall, spot, em1sigma);
    if (Number.isFinite(sigma) && sigma >= THRESHOLDS.proximity.near) {
      return `Spot ${sigma.toFixed(1)}σ below the put wall.`;
    }
    return 'Spot below the put wall.';
  }
  return proximityCopy(spot, putWall, em1sigma, 'put wall');
}
