import type { GEXPoint } from './gex.js';
import type { StrikeOI } from './oi.js';

export interface CpRatios {
  callsOi: number;
  putsOi: number;
  oiCpRatio: number | null;
  callGexUsd: number;
  putGexUsd: number;
  gexCpRatio: number | null;
}

export function cpRatiosFromOi(oi: StrikeOI[]): Pick<CpRatios, 'callsOi' | 'putsOi' | 'oiCpRatio'> {
  let callsOi = 0;
  let putsOi = 0;
  for (const row of oi) {
    callsOi += row.callsOI;
    putsOi += row.putsOI;
  }
  return {
    callsOi,
    putsOi,
    oiCpRatio: putsOi > 0 ? callsOi / putsOi : null,
  };
}

export function cpRatiosFromGex(gex: GEXPoint[]): Pick<CpRatios, 'callGexUsd' | 'putGexUsd' | 'gexCpRatio'> {
  let callGexUsd = 0;
  let putGexUsd = 0;
  for (const pt of gex) {
    callGexUsd += pt.callGex;
    putGexUsd += Math.abs(pt.putGex);
  }
  return {
    callGexUsd,
    putGexUsd,
    gexCpRatio: putGexUsd > 0 ? callGexUsd / putGexUsd : null,
  };
}

export function mergeCpRatios(oi: StrikeOI[], gex: GEXPoint[]): CpRatios {
  return {
    ...cpRatiosFromOi(oi),
    ...cpRatiosFromGex(gex),
  };
}
