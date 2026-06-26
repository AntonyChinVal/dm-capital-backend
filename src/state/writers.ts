import { prisma } from '../db.js';
import {
  enqueueAlertLog,
  enqueueDvolTick,
  enqueueFlowTrade,
  enqueueIndexTick,
  enqueueMetricSnapshot,
  enqueueSurfaceSnapshot,
} from './durableBatcher.js';
import type { Prisma } from '../generated/durable-client/index.js';
import type { Alert } from '../compute/signals.js';
import type { FlowEvent } from '../compute/tradeFlow.js';
import type { GEXPoint } from '../compute/gex.js';
import type { StrikeOI } from '../compute/oi.js';
import type { Regime } from '../compute/gex.js';

/**
 * Persistence writers — fire-and-forget. Errors logged but never block
 * the request path (B11.3). All writes use same Node process.
 */

function logErr(label: string) {
  return (err: unknown) => console.error(`[persist] ${label} failed`, err);
}

export interface MetricSnapshotInput {
  ts: Date;
  currency: string;
  expiration: string;
  future: number;
  maxPain: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  regime: Regime;
  oi: StrikeOI[];
  gex: GEXPoint[];
  atmIv: number | null;
  count: number;
  gexCovered: number;
}

export function persistMetricSnapshot(input: MetricSnapshotInput): void {
  enqueueMetricSnapshot({
    ts: input.ts.getTime(),
    currency: input.currency,
    expiration: input.expiration,
    future: input.future,
    maxPain: input.maxPain,
    gammaFlip: input.gammaFlip,
    callWall: input.callWall,
    putWall: input.putWall,
    regime: input.regime,
    oiSummary: input.oi as unknown as Prisma.InputJsonValue,
    gexSummary: input.gex as unknown as Prisma.InputJsonValue,
    atmIv: input.atmIv,
    count: input.count,
    gexCovered: input.gexCovered,
  });
}

export interface SurfaceSnapshotInput {
  ts: Date;
  currency: string;
  headlineSkew: number | null;
  termStructure: Array<{
    expiration: string;
    tenorDays: number;
    skew25d: number | null;
    callIv?: number | null;
    putIv?: number | null;
  }>;
}

export function persistSurfaceSnapshot(input: SurfaceSnapshotInput): void {
  enqueueSurfaceSnapshot({
    ts: input.ts.getTime(),
    currency: input.currency,
    headlineSkew: input.headlineSkew,
    termStructure: input.termStructure as unknown as Prisma.InputJsonValue,
  });
}

export function persistFlowTrade(ev: FlowEvent): void {
  enqueueFlowTrade({
    id: ev.id,
    ts: ev.ts,
    expiration: ev.expiration,
    strike: ev.strike,
    type: ev.type,
    side: ev.side,
    tag: ev.tag,
    amount: ev.amount,
    notionalUsd: ev.notionalUsd,
    signedNotional: ev.signedNotional,
    iv: ev.iv,
    priorIv: ev.priorIv,
    ivDelta: ev.ivDelta,
    interp: ev.interp,
  });
}

export function persistAlert(alert: Alert): void {
  enqueueAlertLog({
    id: alert.id,
    firstSeen: alert.ts,
    kind: alert.kind,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    contextJson: alert.context ? (alert.context as Prisma.InputJsonValue) : null,
  });
}

export function persistIndexTick(price: number, indexName = 'btc_usd', ts = new Date()): void {
  enqueueIndexTick({
    ts: ts.getTime(),
    indexName,
    price,
  });
}

export function persistDvolTick(value: number, currency = 'BTC', ts = new Date()): void {
  enqueueDvolTick(value, currency, ts);
}

export function persistAggregateSnapshot(buckets: Map<number, unknown>): void {
  const ts = new Date();
  const payload: Record<string, unknown> = {};
  for (const [k, v] of buckets) payload[String(k)] = v;
  prisma.flowAggregateSnapshot.upsert({
    where: { ts },
    create: { ts, buckets: JSON.stringify(payload) },
    update: { buckets: JSON.stringify(payload) },
  }).catch(logErr('flowAggregateSnapshot'));
}
