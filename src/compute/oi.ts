export interface StrikeOI {
  strike: number;
  callsOI: number;
  putsOI: number;
}

export interface StrikeVolume {
  strike: number;
  callsVol: number;
  putsVol: number;
}

export interface StrikeVolOi {
  strike: number;
  callsOI: number;
  putsOI: number;
  callsVol: number;
  putsVol: number;
  /** callsVol / callsOI when OI > 0 */
  volOiCalls: number | null;
  /** putsVol / putsOI when OI > 0 */
  volOiPuts: number | null;
  /** (callsVol + putsVol) / (callsOI + putsOI) when total OI > 0 */
  volOiTotal: number | null;
}

interface OIInput {
  strike: number;
  type: 'C' | 'P';
  openInterest: number;
}

interface VolumeInput {
  strike: number;
  type: 'C' | 'P';
  volume: number;
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

export function volumeByStrike(rows: VolumeInput[]): StrikeVolume[] {
  const m = new Map<number, StrikeVolume>();
  for (const r of rows) {
    const vol = r.volume ?? 0;
    if (vol <= 0) continue;
    let row = m.get(r.strike);
    if (!row) {
      row = { strike: r.strike, callsVol: 0, putsVol: 0 };
      m.set(r.strike, row);
    }
    if (r.type === 'C') row.callsVol += vol;
    else row.putsVol += vol;
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

export function volOiByStrike(oi: StrikeOI[], volume: StrikeVolume[]): StrikeVolOi[] {
  const volMap = new Map(volume.map((v) => [v.strike, v]));
  const strikes = new Set<number>([...oi.map((r) => r.strike), ...volume.map((v) => v.strike)]);
  const out: StrikeVolOi[] = [];
  for (const strike of [...strikes].sort((a, b) => a - b)) {
    const o = oi.find((r) => r.strike === strike) ?? { strike, callsOI: 0, putsOI: 0 };
    const v = volMap.get(strike) ?? { strike, callsVol: 0, putsVol: 0 };
    const totalOi = o.callsOI + o.putsOI;
    const totalVol = v.callsVol + v.putsVol;
    out.push({
      strike,
      callsOI: o.callsOI,
      putsOI: o.putsOI,
      callsVol: v.callsVol,
      putsVol: v.putsVol,
      volOiCalls: o.callsOI > 0 ? v.callsVol / o.callsOI : null,
      volOiPuts: o.putsOI > 0 ? v.putsVol / o.putsOI : null,
      volOiTotal: totalOi > 0 ? totalVol / totalOi : null,
    });
  }
  return out;
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
