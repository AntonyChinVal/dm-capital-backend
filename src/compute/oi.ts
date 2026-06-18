export interface StrikeOI {
  strike: number;
  callsOI: number;
  putsOI: number;
}

interface OIInput {
  strike: number;
  type: 'C' | 'P';
  openInterest: number;
}

export function oiByStrike(rows: OIInput[]): StrikeOI[] {
  const m = new Map<number, StrikeOI>();
  for (const r of rows) {
    let row = m.get(r.strike);
    if (!row) {
      row = { strike: r.strike, callsOI: 0, putsOI: 0 };
      m.set(r.strike, row);
    }
    if (r.type === 'C') row.callsOI += r.openInterest;
    else row.putsOI += r.openInterest;
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

export interface MaxPainResult {
  strike: number;
  totalPayoff: number;
}

/**
 * Max pain: the strike that minimizes total option-holder payoff at expiry.
 * For each candidate K, sum:
 *   sum over calls of (K - strike)+ * callsOI
 * + sum over puts  of (strike - K)+ * putsOI
 */
export function maxPain(strikes: StrikeOI[]): MaxPainResult | null {
  if (!strikes.length) return null;
  let best: MaxPainResult = { strike: strikes[0].strike, totalPayoff: Infinity };
  for (const candidate of strikes) {
    let payoff = 0;
    for (const r of strikes) {
      if (candidate.strike > r.strike) {
        payoff += (candidate.strike - r.strike) * r.callsOI;
      } else if (candidate.strike < r.strike) {
        payoff += (r.strike - candidate.strike) * r.putsOI;
      }
    }
    if (payoff < best.totalPayoff) {
      best = { strike: candidate.strike, totalPayoff: payoff };
    }
  }
  return best;
}
