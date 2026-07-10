import { durablePrisma } from '../db/durable.js';
import { prisma } from '../db.js';
import type { IvGridByDelta } from '../compute/ivGridByTenor.js';
import { getDurableStatus } from './durableBatcher.js';

const LOCAL_HISTORY_MAX_HOURS = Number(process.env.LOCAL_HISTORY_MAX_HOURS ?? 72);

export interface SignalSnapshotRow {
  schemaVersion: number;
  ts: Date;
  currency: string;
  spot: number | null;
  dvol: number | null;
  skew7d: number | null;
  skew30d: number | null;
  skew90d: number | null;
  skew180d: number | null;
  gexNet: number | null;
  gexUnit: string;
  gammaFlip: number | null;
  callWall: number | null;
  cascadeWall: number | null;
  dexNet: number | null;
  vexNet: number | null;
  flowDeltaNet: number | null;
  flowVegaNet: number | null;
  flowPremiumNet: number | null;
  regimeLabel: string | null;
  ivGridByDelta: IvGridByDelta | null;
}

const SIGNAL_SNAPSHOT_SELECT = {
  schemaVersion: true,
  ts: true,
  currency: true,
  spot: true,
  dvol: true,
  skew7d: true,
  skew30d: true,
  skew90d: true,
  skew180d: true,
  gexNet: true,
  gexUnit: true,
  gammaFlip: true,
  callWall: true,
  cascadeWall: true,
  dexNet: true,
  vexNet: true,
  flowDeltaNet: true,
  flowVegaNet: true,
  flowPremiumNet: true,
  regimeLabel: true,
  ivGridByDelta: true,
} as const;

function parseIvGrid(raw: unknown): IvGridByDelta | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as IvGridByDelta;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as IvGridByDelta;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeSignalRow(row: {
  schemaVersion: number;
  ts: Date;
  currency: string;
  spot: number | null;
  dvol: number | null;
  skew7d: number | null;
  skew30d: number | null;
  skew90d: number | null;
  skew180d: number | null;
  gexNet: number | null;
  gexUnit: string;
  gammaFlip: number | null;
  callWall: number | null;
  cascadeWall: number | null;
  dexNet: number | null;
  vexNet: number | null;
  flowDeltaNet: number | null;
  flowVegaNet: number | null;
  flowPremiumNet: number | null;
  regimeLabel: string | null;
  ivGridByDelta: unknown;
}): SignalSnapshotRow {
  return {
    ...row,
    ivGridByDelta: parseIvGrid(row.ivGridByDelta),
  };
}

function useLocalHistory(hours: number): boolean {
  if (hours > LOCAL_HISTORY_MAX_HOURS) return false;
  const durable = getDurableStatus();
  return durable.localDb !== 'degraded';
}

export async function readMetricHistory(
  currency: string,
  expiration: string,
  since: Date,
  hours: number,
) {
  if (useLocalHistory(hours)) {
    try {
      const rows = await prisma.metricSnapshot.findMany({
        where: { currency, expiration, ts: { gte: since } },
        orderBy: { ts: 'asc' },
        select: {
          ts: true,
          future: true,
          maxPain: true,
          gammaFlip: true,
          callWall: true,
          putWall: true,
          regime: true,
          atmIv: true,
        },
      });
      if (rows.length) return { rows, source: 'local' as const };
    } catch (err) {
      console.error('[history] local metric read failed, falling back to Neon', err);
    }
  }

  const rows = await durablePrisma.metricSnapshot.findMany({
    where: { currency, expiration, ts: { gte: since } },
    orderBy: { ts: 'asc' },
    select: {
      ts: true,
      future: true,
      maxPain: true,
      gammaFlip: true,
      callWall: true,
      putWall: true,
      regime: true,
      atmIv: true,
    },
  });
  return { rows, source: 'neon' as const };
}

export async function readIndexHistory(indexName: string, since: Date, hours: number) {
  if (useLocalHistory(hours)) {
    try {
      const rows = await prisma.indexTick.findMany({
        where: { indexName, ts: { gte: since } },
        orderBy: { ts: 'asc' },
        select: { ts: true, price: true },
      });
      if (rows.length) return { rows, source: 'local' as const };
    } catch (err) {
      console.error('[history] local index read failed, falling back to Neon', err);
    }
  }

  const rows = await durablePrisma.indexTick.findMany({
    where: { indexName, ts: { gte: since } },
    orderBy: { ts: 'asc' },
    select: { ts: true, price: true },
  });
  return { rows, source: 'neon' as const };
}

export async function readSignalSnapshot(
  currency: string,
  at?: Date,
): Promise<{ row: SignalSnapshotRow | null; source: 'local' | 'neon' }> {
  const durable = getDurableStatus();
  const tryLocal = !at && durable.localDb !== 'degraded';

  if (tryLocal) {
    try {
      const row = await prisma.signalSnapshot.findFirst({
        where: { currency },
        orderBy: { ts: 'desc' },
        select: SIGNAL_SNAPSHOT_SELECT,
      });
      if (row) return { row: normalizeSignalRow(row), source: 'local' };
    } catch (err) {
      console.error('[history] local signal snapshot read failed, falling back to Neon', err);
    }
  }

  const row = at
    ? await durablePrisma.signalSnapshot.findUnique({
        where: { ts_currency: { ts: at, currency } },
        select: SIGNAL_SNAPSHOT_SELECT,
      })
    : await durablePrisma.signalSnapshot.findFirst({
        where: { currency },
        orderBy: { ts: 'desc' },
        select: SIGNAL_SNAPSHOT_SELECT,
      });

  return { row: row ? normalizeSignalRow(row) : null, source: 'neon' };
}
