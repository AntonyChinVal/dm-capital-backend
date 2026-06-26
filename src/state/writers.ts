import { prisma } from '../db.js';
import { enqueueDvolTick } from './durableBatcher.js';
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
  prisma.metricSnapshot.create({
    data: {
      ts: input.ts,
      currency: input.currency,
      expiration: input.expiration,
      future: input.future,
      maxPain: input.maxPain,
      gammaFlip: input.gammaFlip,
      callWall: input.callWall,
      putWall: input.putWall,
      regime: input.regime,
      oiSummary: JSON.stringify(input.oi),
      gexSummary: JSON.stringify(input.gex),
      atmIv: input.atmIv,
      count: input.count,
      gexCovered: input.gexCovered,
    },
  }).catch(logErr('metricSnapshot'));
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
  prisma.surfaceSnapshot.create({
    data: {
      ts: input.ts,
      currency: input.currency,
      headlineSkew: input.headlineSkew,
      termStructure: JSON.stringify(input.termStructure),
    },
  }).catch(logErr('surfaceSnapshot'));
}

export function persistFlowTrade(ev: FlowEvent): void {
  prisma.flowTrade.create({
    data: {
      id: ev.id,
      ts: new Date(ev.ts),
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
    },
  }).catch((err: unknown) => {
    // Deribit may resend the same trade — duplicate primary key is expected,
    // suppress only that specific error.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Unique constraint')) logErr('flowTrade')(err);
  });
}

export function persistAlert(alert: Alert): void {
  prisma.alertLog.upsert({
    where: { id: alert.id },
    create: {
      id: alert.id,
      firstSeen: new Date(alert.ts),
      kind: alert.kind,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      contextJson: alert.context ? JSON.stringify(alert.context) : null,
    },
    update: {}, // dedup — first seen wins
  }).catch(logErr('alertLog'));
}

export function persistIndexTick(price: number, indexName = 'btc_usd', ts = new Date()): void {
  prisma.indexTick.upsert({
    where: { ts },
    create: { ts, indexName, price },
    update: {},
  }).catch(logErr('indexTick'));
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
