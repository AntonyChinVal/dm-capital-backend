import { durablePrisma } from '../db/durable.js';
import { prisma } from '../db.js';
import { getDurableStatus } from './durableBatcher.js';

const LOCAL_HISTORY_MAX_HOURS = Number(process.env.LOCAL_HISTORY_MAX_HOURS ?? 72);

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
