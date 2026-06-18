import type { BookSummary } from '../types.js';
import { parseInstrument } from './parseInstrument.js';
import { filterLiquidStrikes } from './liquidStrikes.js';
import { ivCurve } from './iv.js';
import { oiByStrike, maxPain } from './oi.js';
import {
  gexByStrike,
  regimeReport,
  type GexInput,
  type GexSweepOption,
  type GEXPoint,
  type Regime,
} from './gex.js';
import { atmIv } from './atmIv.js';
import { expectedMoveBands } from './expectedMove.js';
import { buildSurface } from './ivSurface.js';
import { skew25d } from './skew.js';
import { getGreeks } from '../state/greeks.js';

export interface ParsedOptionRow {
  instrument: string;
  strike: number;
  type: 'C' | 'P';
  expiration: string;
  expirationTimestamp: number;
  openInterest: number;
  volume: number;
  markIv: number;
  underlyingPrice: number;
  interestRate: number;
}

export type MetricsScope = 'market' | 'expiration';

export interface MacroLevels {
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  regime: Regime;
  netGex: number;
}

export interface MetricsBundle {
  future: number;
  count: number;
  maxPain: number | null;
  oi: ReturnType<typeof oiByStrike>;
  ivCurve: ReturnType<typeof ivCurve>;
  gex: GEXPoint[];
  gexCovered: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  regime: Regime;
  expectedMove: ReturnType<typeof expectedMoveBands> | null;
  macro: MacroLevels;
  scope: MetricsScope;
}

export function parseBookRows(data: BookSummary[], now = Date.now()): ParsedOptionRow[] {
  return data
    .map((row) => {
      const p = parseInstrument(row.instrument_name);
      if (!p || p.expirationTimestamp <= now) return null;
      return {
        instrument: p.instrument,
        strike: p.strike,
        type: p.type,
        expiration: p.expiration,
        expirationTimestamp: p.expirationTimestamp,
        openInterest: row.open_interest,
        volume: row.volume ?? 0,
        markIv: row.mark_iv ?? 0,
        underlyingPrice: row.underlying_price,
        interestRate: row.interest_rate ?? 0,
      };
    })
    .filter((r): r is ParsedOptionRow => r !== null);
}

export function tenorYears(expirationTimestamp: number, now = Date.now()): number {
  return Math.max(1 / (365 * 24 * 3600), (expirationTimestamp - now) / (365 * 24 * 3600 * 1000));
}

function toGexRows(rows: ParsedOptionRow[]): GexInput[] {
  const out: GexInput[] = [];
  for (const r of rows) {
    const g = getGreeks(r.instrument);
    if (g?.gamma == null || !Number.isFinite(g.gamma)) continue;
    out.push({
      strike: r.strike,
      type: r.type,
      openInterest: r.openInterest,
      gamma: g.gamma,
      spot: r.underlyingPrice,
    });
  }
  return out;
}

function toSweepOptions(rows: ParsedOptionRow[], now = Date.now()): GexSweepOption[] {
  return rows
    .filter((r) => r.openInterest > 0 && r.markIv > 0)
    .map((r) => ({
      strike: r.strike,
      type: r.type,
      openInterest: r.openInterest,
      iv: r.markIv,
      tenorYears: tenorYears(r.expirationTimestamp, now),
      r: r.interestRate,
    }));
}

function computeScopeLevels(
  liquidRows: ParsedOptionRow[],
  refSpot: number,
  now = Date.now(),
): {
  gex: GEXPoint[];
  gexCovered: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  regime: Regime;
  netGex: number;
} {
  const gexRows = toGexRows(liquidRows);
  const refPrice =
    liquidRows[0]?.underlyingPrice ??
    refSpot;
  const gex = gexByStrike(gexRows, refPrice);
  const sweep = toSweepOptions(liquidRows, now);
  const levels = regimeReport(gex, refSpot, sweep);
  return {
    gex,
    gexCovered: gexRows.length,
    gammaFlip: levels.gammaFlip,
    callWall: levels.callWall,
    putWall: levels.putWall,
    regime: levels.regime,
    netGex: levels.netGex,
  };
}

export function computeMetricsBundle(
  allRows: ParsedOptionRow[],
  expiration: string,
  scope: MetricsScope,
  spotPrice: number,
  now = Date.now(),
): MetricsBundle | null {
  const expRows = allRows.filter((r) => r.expiration === expiration);
  if (!expRows.length) return null;

  const future = expRows[0].underlyingPrice;
  const liquidExp = filterLiquidStrikes(expRows);
  const liquidBook = filterLiquidStrikes(allRows);

  const scopeRows = scope === 'market' ? liquidBook : liquidExp;
  const scopeLevels = computeScopeLevels(scopeRows, spotPrice, now);

  const liquidMacro = filterLiquidStrikes(allRows);
  const macroLevels = computeScopeLevels(liquidMacro, spotPrice, now);

  const oi =
    scope === 'market'
      ? oiByStrike(
          liquidBook.map((r) => ({
            strike: r.strike,
            type: r.type,
            openInterest: r.openInterest,
          })),
        )
      : oiByStrike(expRows);

  const mp = maxPain(oiByStrike(expRows));

  const iv =
    scope === 'market' ? ivCurve(liquidBook) : ivCurve(liquidExp);

  const atmIvValue = atmIv(liquidExp, future);
  const daysToExpiry = (expRows[0].expirationTimestamp - now) / 86_400_000;
  const expectedMove =
    atmIvValue != null ? expectedMoveBands(future, atmIvValue, daysToExpiry) : null;

  return {
    future,
    count: expRows.length,
    maxPain: mp?.strike ?? null,
    oi,
    ivCurve: iv,
    gex: scopeLevels.gex,
    gexCovered: scopeLevels.gexCovered,
    gammaFlip: scopeLevels.gammaFlip,
    callWall: scopeLevels.callWall,
    putWall: scopeLevels.putWall,
    regime: scopeLevels.regime,
    expectedMove,
    macro: {
      gammaFlip: macroLevels.gammaFlip,
      callWall: macroLevels.callWall,
      putWall: macroLevels.putWall,
      regime: macroLevels.regime,
      netGex: macroLevels.netGex,
    },
    scope,
  };
}

export function skewInputsFromRows(rows: ParsedOptionRow[], now = Date.now()) {
  return filterLiquidStrikes(rows).map((r) => ({
    strike: r.strike,
    type: r.type,
    markIv: r.markIv,
    forward: r.underlyingPrice,
    tenorYears: tenorYears(r.expirationTimestamp, now),
    r: r.interestRate,
  }));
}

export function buildSkewTermStructure(allRows: ParsedOptionRow[], maxTenors = 8, now = Date.now()) {
  const liquid = filterLiquidStrikes(allRows);
  const surfaceInput = liquid.map((r) => ({
    instrument: r.instrument,
    strike: r.strike,
    type: r.type,
    markIv: r.markIv,
    expiration: r.expiration,
    expirationTimestamp: r.expirationTimestamp,
  }));
  const surface = buildSurface(surfaceInput, maxTenors);
  return surface.rows.map((sr) => {
    const expRows = liquid.filter((r) => r.expiration === sr.expiration);
    const sk = skew25d(skewInputsFromRows(expRows, now));
    return {
      expiration: sr.expiration,
      tenorDays: sr.tenorDays,
      skew25d: sk.skew25d,
      callIv: sk.callIv ?? null,
      putIv: sk.putIv ?? null,
    };
  });
}
