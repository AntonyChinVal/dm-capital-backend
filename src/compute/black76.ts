/** Black-76 helpers — greeks vs forward F (Deribit convention). */

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function normPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** IV in Deribit percent units (e.g. 40.5 = 40.5%). */
export function gammaB76(F: number, K: number, T: number, ivPct: number, r = 0): number {
  if (ivPct <= 0 || T <= 0 || F <= 0 || K <= 0) return 0;
  const sigma = ivPct / 100;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return (Math.exp(-r * T) * normPdf(d1)) / (F * sigma * Math.sqrt(T));
}

export function deltaB76(
  F: number,
  K: number,
  T: number,
  ivPct: number,
  r: number,
  type: 'C' | 'P',
): number {
  if (ivPct <= 0 || T <= 0 || F <= 0 || K <= 0) return 0;
  const sigma = ivPct / 100;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const df = Math.exp(-r * T);
  return type === 'C' ? df * normCdf(d1) : -df * normCdf(-d1);
}
