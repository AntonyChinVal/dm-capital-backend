import { prisma } from '../db.js';
import type {
  DvolTickPayload,
  IndexTickPayload,
  MetricSnapshotPayload,
  SignalSnapshotPayload,
} from './durableBatcher.js';

function logErr(label: string) {
  return (err: unknown) => console.error(`[local-mirror] ${label} failed`, err);
}

export function mirrorMetricSnapshot(payload: MetricSnapshotPayload): void {
  prisma.metricSnapshot.create({
    data: {
      ts: new Date(payload.ts),
      currency: payload.currency,
      expiration: payload.expiration,
      future: payload.future,
      maxPain: payload.maxPain,
      gammaFlip: payload.gammaFlip,
      callWall: payload.callWall,
      putWall: payload.putWall,
      regime: payload.regime,
      oiSummary: JSON.stringify(payload.oiSummary),
      gexSummary: JSON.stringify(payload.gexSummary),
      atmIv: payload.atmIv,
      count: payload.count,
      gexCovered: payload.gexCovered,
    },
  }).catch(logErr('metricSnapshot'));
}

export function mirrorIndexTick(payload: IndexTickPayload): void {
  prisma.indexTick.upsert({
    where: { ts: new Date(payload.ts) },
    create: {
      ts: new Date(payload.ts),
      indexName: payload.indexName,
      price: payload.price,
    },
    update: {
      indexName: payload.indexName,
      price: payload.price,
    },
  }).catch(logErr('indexTick'));
}

export function mirrorDvolTick(payload: DvolTickPayload): void {
  prisma.dvolTick.upsert({
    where: { ts_currency: { ts: new Date(payload.ts), currency: payload.currency } },
    create: {
      ts: new Date(payload.ts),
      currency: payload.currency,
      value: payload.value,
    },
    update: {
      value: payload.value,
    },
  }).catch(logErr('dvolTick'));
}

export function mirrorSignalSnapshot(payload: SignalSnapshotPayload): void {
  prisma.signalSnapshot.upsert({
    where: { ts_currency: { ts: new Date(payload.ts), currency: payload.currency } },
    create: {
      ts: new Date(payload.ts),
      currency: payload.currency,
      schemaVersion: payload.schemaVersion,
      spot: payload.spot,
      dvol: payload.dvol,
      skew7d: payload.skew7d,
      skew30d: payload.skew30d,
      skew90d: payload.skew90d,
      skew180d: payload.skew180d,
      gexNet: payload.gexNet,
      gexUnit: payload.gexUnit,
      gammaFlip: payload.gammaFlip,
      callWall: payload.callWall,
      cascadeWall: payload.cascadeWall,
      dexNet: payload.dexNet,
      vexNet: payload.vexNet,
      flowDeltaNet: payload.flowDeltaNet,
      flowVegaNet: payload.flowVegaNet,
      flowPremiumNet: payload.flowPremiumNet,
      regimeLabel: payload.regimeLabel,
      ivGridByDelta: payload.ivGridByDelta ? JSON.stringify(payload.ivGridByDelta) : null,
    },
    update: {
      schemaVersion: payload.schemaVersion,
      spot: payload.spot,
      dvol: payload.dvol,
      skew7d: payload.skew7d,
      skew30d: payload.skew30d,
      skew90d: payload.skew90d,
      skew180d: payload.skew180d,
      gexNet: payload.gexNet,
      gexUnit: payload.gexUnit,
      gammaFlip: payload.gammaFlip,
      callWall: payload.callWall,
      cascadeWall: payload.cascadeWall,
      dexNet: payload.dexNet,
      vexNet: payload.vexNet,
      flowDeltaNet: payload.flowDeltaNet,
      flowVegaNet: payload.flowVegaNet,
      flowPremiumNet: payload.flowPremiumNet,
      regimeLabel: payload.regimeLabel,
      ivGridByDelta: payload.ivGridByDelta ? JSON.stringify(payload.ivGridByDelta) : null,
    },
  }).catch(logErr('signalSnapshot'));
}
