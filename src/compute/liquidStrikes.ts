/** Strike-level liquidity filter — removes far-OTM garbage IV from long tenors. */

export interface LiquidFilterable {
  strike: number;
  openInterest: number;
  volume?: number;
  markIv: number;
  underlyingPrice: number;
}

export interface LiquidFilterOptions {
  minMoneyness?: number;
  maxMoneyness?: number;
}

const DEFAULT_MIN_MONEYNESS = 0.4;
const DEFAULT_MAX_MONEYNESS = 2.5;

/**
 * Keep strikes with activity and reasonable moneyness vs each row's forward.
 * Does not filter expirations — strike-level only (Hernán Q5).
 */
export function filterLiquidStrikes<T extends LiquidFilterable>(
  rows: T[],
  opts: LiquidFilterOptions = {},
): T[] {
  const minM = opts.minMoneyness ?? DEFAULT_MIN_MONEYNESS;
  const maxM = opts.maxMoneyness ?? DEFAULT_MAX_MONEYNESS;

  return rows.filter((r) => {
    if (!r.markIv || r.markIv <= 0) return false;
    if (r.openInterest <= 0 && (r.volume ?? 0) <= 0) return false;
    const F = r.underlyingPrice;
    if (!F || F <= 0) return false;
    return r.strike >= F * minM && r.strike <= F * maxM;
  });
}
