import { buildSkewTermStructure, computeMetricsBundle, parseBookRows } from '../compute/metricsBundle.js';
import type { BookSummary } from '../types.js';
import { getDvol } from './dvol.js';
import { flowAggregator } from './aggregator.js';
import { enqueueSignalSnapshot, type SignalSnapshotPayload } from './durableBatcher.js';

const SIGNAL_SCHEMA_VERSION = 1;
const CONSTANT_TENORS = [7, 30, 90, 180] as const;

type ConstantTenor = typeof CONSTANT_TENORS[number];

function minuteMs(ts = Date.now()): number {
  return Math.floor(ts / 60_000) * 60_000;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nearestExpiration(rows: ReturnType<typeof parseBookRows>): string | null {
  const future = rows
    .map((r) => ({ expiration: r.expiration, ts: r.expirationTimestamp }))
    .sort((a, b) => a.ts - b.ts)[0];
  return future?.expiration ?? null;
}

function interpolateByTenor(
  points: Array<{ tenorDays: number; skew25d: number | null }>,
  target: ConstantTenor,
): number | null {
  const valid = points
    .filter((p): p is { tenorDays: number; skew25d: number } =>
      Number.isFinite(p.tenorDays) && p.skew25d != null && Number.isFinite(p.skew25d),
    )
    .sort((a, b) => a.tenorDays - b.tenorDays);

  if (!valid.length) return null;
  const exact = valid.find((p) => p.tenorDays === target);
  if (exact) return exact.skew25d;

  const before = [...valid].reverse().find((p) => p.tenorDays < target);
  const after = valid.find((p) => p.tenorDays > target);

  // Avoid extrapolating far outside the live term structure; NULL means not measured.
  if (!before || !after || after.tenorDays === before.tenorDays) return null;
  const t = (target - before.tenorDays) / (after.tenorDays - before.tenorDays);
  return before.skew25d + (after.skew25d - before.skew25d) * t;
}

function constantSkews(term: Array<{ tenorDays: number; skew25d: number | null }>): {
  skew7d: number | null;
  skew30d: number | null;
  skew90d: number | null;
  skew180d: number | null;
} {
  return {
    skew7d: interpolateByTenor(term, 7),
    skew30d: interpolateByTenor(term, 30),
    skew90d: interpolateByTenor(term, 90),
    skew180d: interpolateByTenor(term, 180),
  };
}

export function buildSignalSnapshot(
  summary: BookSummary[],
  spot: number,
  now = Date.now(),
): SignalSnapshotPayload | null {
  const allRows = parseBookRows(summary, now);
  const expiration = nearestExpiration(allRows);
  if (!expiration) return null;

  // Separate hysteresis namespace from the live read path: persistence runs on
  // its own cadence and must not contaminate (or be contaminated by) live state.
  const bundle = computeMetricsBundle(allRows, expiration, 'market', spot, now, {
    cascadeHysteresisKey: 'persist:BTC',
  });
  if (!bundle) return null;

  const term = buildSkewTermStructure(allRows, {
    maxTenors: 'all',
    excludeZeroDte: true,
  }, now);
  const flow1m = flowAggregator.netForWindow(1, now);
  const dvol = getDvol('btc_usd');

  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    ts: minuteMs(now),
    currency: 'BTC',
    spot: finiteOrNull(spot),
    dvol: finiteOrNull(dvol?.value),
    ...constantSkews(term),
    gexNet: finiteOrNull(bundle.macro.netGex),
    gammaFlip: finiteOrNull(bundle.macro.gammaFlip),
    callWall: finiteOrNull(bundle.macro.callWall),
    cascadeWall: finiteOrNull(bundle.macro.putWall),
    dexNet: finiteOrNull(bundle.dexSummary.netDex),
    vexNet: finiteOrNull(bundle.vexSummary.netVex),
    flowDeltaNet: flow1m.deltaCount > 0 ? finiteOrNull(flow1m.deltaFlowUsd) : null,
    flowVegaNet: flow1m.vegaCount > 0 ? finiteOrNull(flow1m.vegaFlowUsd) : null,
    flowPremiumNet: flow1m.bucketsUsed > 0 ? finiteOrNull(flow1m.signedNotional) : null,
    regimeLabel: null,
  };
}

export function persistSignalSnapshot(summary: BookSummary[], spot: number, now = Date.now()): void {
  const snapshot = buildSignalSnapshot(summary, spot, now);
  if (!snapshot) return;
  enqueueSignalSnapshot(snapshot);
}
