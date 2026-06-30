import type { BookSummary } from '../types.js';
import { gammaB76, vannaB76 } from './black76.js';
import { parseInstrument } from './parseInstrument.js';
import { filterLiquidStrikes, LIQUID_STRIKE_FILTER } from './liquidStrikes.js';
import { filterCurveStrikes } from './curveFilter.js';
import { ivCurve } from './iv.js';
import { oiByStrike, maxPain, volumeByStrike, volOiByStrike, type StrikeVolOi } from './oi.js';
import {
  dexByStrike,
  dexSummary,
  gexByStrike,
  regimeReport,
  resistanceWall,
  structuralCallWall,
  structuralCallWallStable,
  putSideWall,
  putSideWallStable,
  vexByStrike,
  vexSummary,
  type DEXPoint,
  type DexInput,
  type DexSummary,
  type GexInput,
  type GexSweepOption,
  type GEXPoint,
  type Regime,
  type VEXPoint,
  type VexInput,
  type VexSummary,
} from './gex.js';
import { atmIv } from './atmIv.js';
import { expectedMoveBands } from './expectedMove.js';
import { skew25d } from './skew.js';
import { rankKeyStrikes, type KeyStrikeRow, type KeyStrikesBundle } from './keyStrikes.js';
import { mergeCpRatios, type CpRatios } from './marketRatios.js';
import { getGreeks } from '../state/greeks.js';

export type { KeyStrikeRow, KeyStrikesBundle } from './keyStrikes.js';
export type { StrikeVolOi } from './oi.js';
export type { CpRatios } from './marketRatios.js';

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
export type LevelScope = 'global' | 'local';

export interface LevelMetric {
  value: number | null;
  expiration: string | null;
  scope: LevelScope;
}

export interface WallsBundle {
  marketGammaFlip: LevelMetric;
  structuralCallWall: LevelMetric;
  structuralPutWall: LevelMetric;
  localResistance: LevelMetric;
  localSupport: LevelMetric;
  maxPain: LevelMetric;
}

export interface MacroLevels {
  gammaFlip: number | null;
  /** Full-book structural call wall (max GEX calls). */
  callWall: number | null;
  /** Full-book structural put wall (max GEX puts). */
  putWall: number | null;
  regime: Regime;
  netGex: number;
}

export interface LocalLevels {
  resistance: number | null;
  support: number | null;
  expiration: string;
}

export interface MetricsBundle {
  future: number;
  count: number;
  maxPain: number | null;
  oi: ReturnType<typeof oiByStrike>;
  volume: ReturnType<typeof volumeByStrike>;
  volOi: StrikeVolOi[];
  keyStrikes: KeyStrikesBundle;
  ivCurve: ReturnType<typeof ivCurve>;
  gex: GEXPoint[];
  dex: DEXPoint[];
  dexSummary: DexSummary;
  vex: VEXPoint[];
  vexSummary: VexSummary;
  gexCovered: number;
  dexCovered: number;
  vexCovered: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  regime: Regime;
  expectedMove: ReturnType<typeof expectedMoveBands> | null;
  macro: MacroLevels;
  local: LocalLevels;
  walls: WallsBundle;
  scope: MetricsScope;
}

function globalLevel(value: number | null): LevelMetric {
  return { value, expiration: null, scope: 'global' };
}

function localLevel(value: number | null, expiration: string): LevelMetric {
  return { value, expiration, scope: 'local' };
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

function rowGamma(r: ParsedOptionRow, now: number): number | null {
  const g = getGreeks(r.instrument);
  if (g?.gamma != null && Number.isFinite(g.gamma) && g.gamma !== 0) return g.gamma;
  if (r.markIv <= 0) return null;
  return gammaB76(
    r.underlyingPrice,
    r.strike,
    tenorYears(r.expirationTimestamp, now),
    r.markIv,
    r.interestRate,
  );
}

function toGexRows(rows: ParsedOptionRow[], now = Date.now()): GexInput[] {
  const out: GexInput[] = [];
  for (const r of rows) {
    const gamma = rowGamma(r, now);
    if (gamma == null || !Number.isFinite(gamma) || gamma === 0) continue;
    out.push({
      strike: r.strike,
      type: r.type,
      openInterest: r.openInterest,
      gamma,
      spot: r.underlyingPrice,
    });
  }
  return out;
}

function toDexRows(rows: ParsedOptionRow[]): DexInput[] {
  const out: DexInput[] = [];
  for (const r of rows) {
    const delta = getGreeks(r.instrument)?.delta;
    if (delta == null || !Number.isFinite(delta) || delta === 0) continue;
    out.push({
      strike: r.strike,
      type: r.type,
      openInterest: r.openInterest,
      delta,
      spot: r.underlyingPrice,
    });
  }
  return out;
}

function toVexRows(rows: ParsedOptionRow[], now = Date.now()): VexInput[] {
  const out: VexInput[] = [];
  for (const r of rows) {
    if (r.openInterest <= 0 || r.markIv <= 0) continue;
    const vanna = vannaB76(
      r.underlyingPrice,
      r.strike,
      tenorYears(r.expirationTimestamp, now),
      r.markIv,
    );
    if (!Number.isFinite(vanna) || vanna === 0) continue;
    out.push({
      strike: r.strike,
      type: r.type,
      openInterest: r.openInterest,
      vanna,
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

function buildPutLiquidityMaps(rows: ParsedOptionRow[]): {
  putOiByStrike: Map<number, number>;
  putVolumeByStrike: Map<number, number>;
} {
  const putOiByStrike = new Map<number, number>();
  const putVolumeByStrike = new Map<number, number>();
  for (const r of rows) {
    if (r.type !== 'P') continue;
    putOiByStrike.set(r.strike, (putOiByStrike.get(r.strike) ?? 0) + r.openInterest);
    putVolumeByStrike.set(r.strike, (putVolumeByStrike.get(r.strike) ?? 0) + (r.volume ?? 0));
  }
  return { putOiByStrike, putVolumeByStrike };
}

function buildCallLiquidityMaps(rows: ParsedOptionRow[]): {
  callOiByStrike: Map<number, number>;
} {
  const callOiByStrike = new Map<number, number>();
  for (const r of rows) {
    if (r.type !== 'C') continue;
    callOiByStrike.set(r.strike, (callOiByStrike.get(r.strike) ?? 0) + r.openInterest);
  }
  return { callOiByStrike };
}

function computeScopeLevels(
  liquidRows: ParsedOptionRow[],
  refSpot: number,
  wallRefPrice: number,
  opts?: {
    putOiByStrike?: Map<number, number>;
    putVolumeByStrike?: Map<number, number>;
    callOiByStrike?: Map<number, number>;
    /** When set, apply cascade hysteresis to the structural put wall (live read path only). */
    hysteresisKey?: string;
    /** When set, apply call-wall hysteresis to structural call (live read path only). */
    callHysteresisKey?: string;
  },
  now = Date.now(),
): {
  gex: GEXPoint[];
  dex: DEXPoint[];
  vex: VEXPoint[];
  gexCovered: number;
  dexCovered: number;
  vexCovered: number;
  dexSummary: DexSummary;
  vexSummary: VexSummary;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  resistance: number | null;
  support: number | null;
  structuralCall: number | null;
  structuralPut: number | null;
  regime: Regime;
  netGex: number;
} {
  const gexRows = toGexRows(liquidRows, now);
  const refPrice =
    liquidRows[0]?.underlyingPrice ??
    refSpot;
  const gex = gexByStrike(gexRows, refPrice);
  const dexRows = toDexRows(liquidRows);
  const dex = dexByStrike(dexRows, refPrice);
  const dexStats = dexSummary(dex);
  const vexRows = toVexRows(liquidRows, now);
  const vex = vexByStrike(vexRows, refPrice);
  const vexStats = vexSummary(vex);
  const sweep = toSweepOptions(liquidRows, now);
  const levels = regimeReport(gex, refSpot, sweep);
  const putSideOpts = opts
    ? { putOiByStrike: opts.putOiByStrike, putVolumeByStrike: opts.putVolumeByStrike }
    : undefined;
  const structuralPut = opts?.hysteresisKey
    ? putSideWallStable(gex, refSpot, opts.hysteresisKey, putSideOpts)
    : putSideWall(gex, refSpot, putSideOpts);
  const support = putSideWall(gex, wallRefPrice, putSideOpts);
  const callWallOpts = opts?.callOiByStrike
    ? { callOiByStrike: opts.callOiByStrike }
    : undefined;
  const structuralCall = opts?.callHysteresisKey
    ? structuralCallWallStable(gex, opts.callHysteresisKey, callWallOpts)
    : structuralCallWall(gex, callWallOpts);
  return {
    gex,
    dex,
    vex,
    gexCovered: gexRows.length,
    dexCovered: dexRows.length,
    vexCovered: vexRows.length,
    dexSummary: dexStats,
    vexSummary: vexStats,
    gammaFlip: levels.gammaFlip,
    callWall: levels.callWall,
    putWall: structuralPut,
    resistance: resistanceWall(gex, wallRefPrice),
    support,
    structuralCall,
    structuralPut,
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
  opts?: {
    /**
     * Stabilize the macro cascade wall against flicker (Hernán 2026-06-26).
     * Pass only from the live read path (e.g. 'BTC'); leave undefined for
     * persistence so snapshot state never contaminates the live hysteresis.
     */
    cascadeHysteresisKey?: string;
  },
): MetricsBundle | null {
  const expRows = allRows.filter((r) => r.expiration === expiration);
  if (!expRows.length) return null;

  const future = expRows[0].underlyingPrice;
  const liquidExp = filterLiquidStrikes(expRows);
  const liquidBook = filterLiquidStrikes(allRows);

  const scopeRows = scope === 'market' ? liquidBook : liquidExp;
  const macroLiquidity = buildPutLiquidityMaps(liquidBook);
  const macroCallLiquidity = buildCallLiquidityMaps(liquidBook);
  const localLiquidity = buildPutLiquidityMaps(liquidExp);

  const scopeLevels = computeScopeLevels(
    scopeRows,
    spotPrice,
    future,
    scope === 'market' ? macroLiquidity : localLiquidity,
    now,
  );

  const liquidMacro = filterLiquidStrikes(allRows);
  const macroLevels = computeScopeLevels(
    liquidMacro,
    spotPrice,
    spotPrice,
    opts?.cascadeHysteresisKey
      ? {
          ...macroLiquidity,
          ...macroCallLiquidity,
          hysteresisKey: `${opts.cascadeHysteresisKey}:macro-cascade`,
          callHysteresisKey: `${opts.cascadeHysteresisKey}:macro-call`,
        }
      : { ...macroLiquidity, ...macroCallLiquidity },
    now,
  );
  const localLevels = computeScopeLevels(liquidExp, spotPrice, future, localLiquidity, now);

  const scopeCallWall =
    scope === 'market' ? macroLevels.structuralCall : localLevels.resistance;
  const scopePutWall = scope === 'market' ? macroLevels.structuralPut : localLevels.support;

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

  // Smile/smirk is always per selected expiration — never full-book aggregate.
  const curveSource = filterCurveStrikes(liquidExp, { now });
  const iv = ivCurve(curveSource);

  const volume =
    scope === 'market'
      ? volumeByStrike(
          liquidBook.map((r) => ({
            strike: r.strike,
            type: r.type,
            volume: r.volume,
          })),
        )
      : volumeByStrike(expRows);
  const volOi = volOiByStrike(oi, volume);
  const keyStrikes = rankKeyStrikes(scopeLevels.gex, oi, volume);

  const atmIvValue = atmIv(liquidExp, future);
  const daysToExpiry = (expRows[0].expirationTimestamp - now) / 86_400_000;
  const expectedMove =
    atmIvValue != null ? expectedMoveBands(future, atmIvValue, daysToExpiry) : null;

  const maxPainStrike = mp?.strike ?? null;

  return {
    future,
    count: expRows.length,
    maxPain: maxPainStrike,
    oi,
    volume,
    volOi,
    keyStrikes,
    ivCurve: iv,
    gex: scopeLevels.gex,
    dex: scopeLevels.dex,
    dexSummary: scopeLevels.dexSummary,
    vex: scopeLevels.vex,
    vexSummary: scopeLevels.vexSummary,
    gexCovered: scopeLevels.gexCovered,
    dexCovered: scopeLevels.dexCovered,
    vexCovered: scopeLevels.vexCovered,
    gammaFlip: scopeLevels.gammaFlip,
    callWall: scopeCallWall,
    putWall: scopePutWall,
    regime: scopeLevels.regime,
    expectedMove,
    macro: {
      gammaFlip: macroLevels.gammaFlip,
      callWall: macroLevels.structuralCall,
      putWall: macroLevels.structuralPut,
      regime: macroLevels.regime,
      netGex: macroLevels.netGex,
    },
    local: {
      resistance: localLevels.resistance,
      support: localLevels.support,
      expiration,
    },
    walls: {
      marketGammaFlip: globalLevel(macroLevels.gammaFlip),
      structuralCallWall: globalLevel(macroLevels.structuralCall),
      structuralPutWall: globalLevel(macroLevels.structuralPut),
      localResistance: localLevel(localLevels.resistance, expiration),
      localSupport: localLevel(localLevels.support, expiration),
      maxPain: localLevel(maxPainStrike, expiration),
    },
    scope,
  };
}

export function skewInputsFromRows(rows: ParsedOptionRow[], now = Date.now()) {
  return filterCurveStrikes(filterLiquidStrikes(rows), { now }).map((r) => ({
    strike: r.strike,
    type: r.type,
    markIv: r.markIv,
    forward: r.underlyingPrice,
    tenorYears: tenorYears(r.expirationTimestamp, now),
    r: r.interestRate,
  }));
}

export interface SkewTermStructureOptions {
  /** Cap tenors for skew series; default = all expirations in the book. */
  maxTenors?: number | 'all';
  /** Drop same-day / 0DTE expirations (skew term chart). */
  excludeZeroDte?: boolean;
}

export function buildSkewTermStructure(
  allRows: ParsedOptionRow[],
  opts: SkewTermStructureOptions | number = { maxTenors: 'all' },
  now = Date.now(),
) {
  const options: SkewTermStructureOptions =
    typeof opts === 'number' ? { maxTenors: opts } : opts;
  const maxTenors = options.maxTenors ?? 'all';
  const excludeZeroDte = options.excludeZeroDte ?? false;

  const curveLiquid = filterCurveStrikes(filterLiquidStrikes(allRows), { now });
  const byExp = new Map<string, { ts: number; rows: ParsedOptionRow[] }>();
  for (const r of curveLiquid) {
    let bucket = byExp.get(r.expiration);
    if (!bucket) {
      bucket = { ts: r.expirationTimestamp, rows: [] };
      byExp.set(r.expiration, bucket);
    }
    bucket.rows.push(r);
  }

  let exps = [...byExp.entries()].sort((a, b) => a[1].ts - b[1].ts);

  if (excludeZeroDte) {
    exps = exps.filter(([, bucket]) => {
      const tenorDays = Math.max(1, Math.round((bucket.ts - now) / 86_400_000));
      return tenorDays > 1;
    });
  }

  if (maxTenors !== 'all') {
    exps = exps.slice(0, maxTenors);
  }

  return exps.map(([expiration, bucket]) => {
    const sk = skew25d(skewInputsFromRows(bucket.rows, now));
    return {
      expiration,
      tenorDays: Math.max(1, Math.round((bucket.ts - now) / 86_400_000)),
      skew25d: sk.skew25d,
      callIv: sk.callIv ?? null,
      putIv: sk.putIv ?? null,
    };
  });
}

export interface AtmTermPoint {
  expiration: string;
  tenorDays: number;
  atmIv: number | null;
}

/** ATM IV level vs DTE for all expirations in the book. */
export function buildAtmTermStructure(allRows: ParsedOptionRow[], now = Date.now()): AtmTermPoint[] {
  const liquid = filterLiquidStrikes(allRows);
  const byExp = new Map<string, { ts: number; rows: ParsedOptionRow[] }>();
  for (const r of liquid) {
    let bucket = byExp.get(r.expiration);
    if (!bucket) {
      bucket = { ts: r.expirationTimestamp, rows: [] };
      byExp.set(r.expiration, bucket);
    }
    bucket.rows.push(r);
  }
  return [...byExp.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .map(([expiration, bucket]) => {
      const forward = bucket.rows[0]?.underlyingPrice ?? 0;
      return {
        expiration,
        tenorDays: Math.max(1, Math.round((bucket.ts - now) / 86_400_000)),
        atmIv: forward > 0 ? atmIv(bucket.rows, forward) : null,
      };
    });
}

export interface ExpectedMoveRow {
  expiration: string;
  tenorDays: number;
  atmIv: number | null;
  sigma1: number | null;
  sigma2: number | null;
}

/** Expected move bands for every future expiration. */
export function buildExpectedMoveTable(
  allRows: ParsedOptionRow[],
  spot: number,
  now = Date.now(),
): ExpectedMoveRow[] {
  const liquid = filterLiquidStrikes(allRows);
  const byExp = new Map<string, { ts: number; rows: ParsedOptionRow[] }>();
  for (const r of liquid) {
    if (r.expirationTimestamp <= now) continue;
    let bucket = byExp.get(r.expiration);
    if (!bucket) {
      bucket = { ts: r.expirationTimestamp, rows: [] };
      byExp.set(r.expiration, bucket);
    }
    bucket.rows.push(r);
  }
  return [...byExp.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .map(([expiration, bucket]) => {
      const forward = bucket.rows[0]?.underlyingPrice ?? spot;
      const tenorDays = Math.max(0.01, (bucket.ts - now) / 86_400_000);
      const iv = forward > 0 ? atmIv(bucket.rows, forward) : null;
      const bands = iv != null ? expectedMoveBands(forward, iv, tenorDays) : null;
      return {
        expiration,
        tenorDays,
        atmIv: iv,
        sigma1: bands?.sigma1 ?? null,
        sigma2: bands?.sigma2 ?? null,
      };
    });
}

/** Full-book C/P ratios for header (OI + GEX). */
export function computeMarketRatios(
  allRows: ParsedOptionRow[],
  spot: number,
  now = Date.now(),
): CpRatios & {
  oiCpScope: 'full_book_liquid';
  gexCpScope: 'full_book_liquid';
  liquidFilter: typeof LIQUID_STRIKE_FILTER;
} {
  const liquid = filterLiquidStrikes(allRows);
  const oi = oiByStrike(
    liquid.map((r) => ({
      strike: r.strike,
      type: r.type,
      openInterest: r.openInterest,
    })),
  );
  const refPrice = liquid[0]?.underlyingPrice ?? spot;
  const gex = gexByStrike(toGexRows(liquid, now), refPrice);
  return {
    ...mergeCpRatios(oi, gex),
    oiCpScope: 'full_book_liquid',
    gexCpScope: 'full_book_liquid',
    liquidFilter: LIQUID_STRIKE_FILTER,
  };
}
