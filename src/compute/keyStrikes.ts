import type { GEXPoint } from './gex.js';
import type { StrikeOI, StrikeVolume } from './oi.js';

export interface KeyStrikeRow {
  strike: number;
  netGex: number;
  totalOi: number;
  totalVol: number;
  volOiRatio: number | null;
}

export interface KeyStrikesBundle {
  topByGex: KeyStrikeRow[];
  topByOi: KeyStrikeRow[];
  topByVol: KeyStrikeRow[];
}

function mergeStrikeRows(
  gex: GEXPoint[],
  oi: StrikeOI[],
  volume: StrikeVolume[],
): KeyStrikeRow[] {
  const m = new Map<number, KeyStrikeRow>();
  const touch = (strike: number): KeyStrikeRow => {
    let row = m.get(strike);
    if (!row) {
      row = { strike, netGex: 0, totalOi: 0, totalVol: 0, volOiRatio: null };
      m.set(strike, row);
    }
    return row;
  };
  for (const pt of gex) {
    const row = touch(pt.strike);
    row.netGex = pt.netGex;
  }
  for (const pt of oi) {
    const row = touch(pt.strike);
    row.totalOi = pt.callsOI + pt.putsOI;
  }
  for (const pt of volume) {
    const row = touch(pt.strike);
    row.totalVol = pt.callsVol + pt.putsVol;
  }
  for (const row of m.values()) {
    row.volOiRatio = row.totalOi > 0 ? row.totalVol / row.totalOi : null;
  }
  return [...m.values()];
}

function topBy(
  rows: KeyStrikeRow[],
  sortFn: (a: KeyStrikeRow, b: KeyStrikeRow) => number,
  topN: number,
): KeyStrikeRow[] {
  return [...rows].sort(sortFn).slice(0, topN);
}

/** Separate top-N lists per metric (Hernán 2026-06-26). */
export function rankKeyStrikes(
  gex: GEXPoint[],
  oi: StrikeOI[],
  volume: StrikeVolume[],
  topN = 6,
): KeyStrikesBundle {
  const rows = mergeStrikeRows(gex, oi, volume);
  if (!rows.length) {
    return { topByGex: [], topByOi: [], topByVol: [] };
  }
  return {
    topByGex: topBy(rows, (a, b) => Math.abs(b.netGex) - Math.abs(a.netGex), topN),
    topByOi: topBy(rows, (a, b) => b.totalOi - a.totalOi, topN),
    topByVol: topBy(rows, (a, b) => b.totalVol - a.totalVol, topN),
  };
}
