import { durablePrisma } from '../db/durable.js';
// Outbox lives in the same SQLite file the legacy client owns. Reuse that single
// client to avoid two Prisma engines opening one SQLite file (lock contention →
// "disk I/O error"). When legacy SQLite tables are fully retired, this can move
// to a dedicated local client + file.
import { prisma as localPrisma } from '../db.js';

const DEFAULT_FLUSH_INTERVAL_MS = 10 * 60_000;
const OUTBOX_TTL_MS = 48 * 60 * 60_000;
const MAX_FLUSH_ROWS = 500;

export const PERSIST_FLUSH_INTERVAL_MS = Number(
  process.env.PERSIST_FLUSH_INTERVAL_MS ?? DEFAULT_FLUSH_INTERVAL_MS,
);

type DurableKind = 'dvolTick' | 'signalSnapshot';

export interface DurableStatus {
  durableDb: 'ok' | 'degraded' | 'unknown';
  localDb: 'ok' | 'degraded' | 'unknown';
  pendingOutbox: number;
  lastDvolWrite: number | null;
  lastSignalWrite: number | null;
  lastFlushAt: number | null;
  lastFlushError: string | null;
  flushIntervalMs: number;
}

export interface DvolTickPayload {
  ts: number;
  currency: string;
  value: number;
}

export interface SignalSnapshotPayload {
  schemaVersion: number;
  ts: number;
  currency: string;
  spot: number | null;
  dvol: number | null;
  skew7d: number | null;
  skew30d: number | null;
  skew90d: number | null;
  skew180d: number | null;
  gexNet: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  cascadeWall: number | null;
  dexNet: number | null;
  flowDeltaNet: number | null;
  flowVegaNet: number | null;
  flowPremiumNet: number | null;
  regimeLabel: string | null;
}

interface OutboxPayloads {
  dvolTick: DvolTickPayload;
  signalSnapshot: SignalSnapshotPayload;
}

const status: DurableStatus = {
  durableDb: 'unknown',
  localDb: 'unknown',
  pendingOutbox: 0,
  lastDvolWrite: null,
  lastSignalWrite: null,
  lastFlushAt: null,
  lastFlushError: null,
  flushIntervalMs: PERSIST_FLUSH_INTERVAL_MS,
};

function minuteDate(ts: Date): Date {
  return new Date(Math.floor(ts.getTime() / 60_000) * 60_000);
}

function serialiseErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function outboxId(kind: DurableKind, currency: string, ts: number): string {
  return `${kind}:${currency}:${ts}`;
}

async function enqueue<K extends DurableKind>(
  kind: K,
  payload: OutboxPayloads[K],
): Promise<void> {
  const id = outboxId(kind, payload.currency, payload.ts);
  await localPrisma.durableOutbox.upsert({
    where: { id },
    create: {
      id,
      kind,
      payload: JSON.stringify(payload),
    },
    update: {
      payload: JSON.stringify(payload),
      lastError: null,
    },
  });
  status.localDb = 'ok';
}

export function enqueueDvolTick(value: number, currency = 'BTC', ts = new Date()): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const minute = minuteDate(ts);
  enqueue('dvolTick', {
    ts: minute.getTime(),
    currency,
    value,
  }).catch((err: unknown) => {
    status.localDb = 'degraded';
    console.error('[persist] dvolTick outbox failed', err);
  });
}

export function enqueueSignalSnapshot(payload: SignalSnapshotPayload): void {
  const minute = minuteDate(new Date(payload.ts));
  enqueue('signalSnapshot', {
    ...payload,
    ts: minute.getTime(),
  }).catch((err: unknown) => {
    status.localDb = 'degraded';
    console.error('[persist] signalSnapshot outbox failed', err);
  });
}

async function writeDvol(payload: DvolTickPayload): Promise<void> {
  await durablePrisma.dvolTick.upsert({
    where: { ts_currency: { ts: new Date(payload.ts), currency: payload.currency } },
    create: {
      ts: new Date(payload.ts),
      currency: payload.currency,
      value: payload.value,
    },
    update: {
      value: payload.value,
    },
  });
  status.lastDvolWrite = Date.now();
}

async function writeSignal(payload: SignalSnapshotPayload): Promise<void> {
  await durablePrisma.signalSnapshot.upsert({
    where: { ts_currency: { ts: new Date(payload.ts), currency: payload.currency } },
    create: {
      ...payload,
      ts: new Date(payload.ts),
    },
    update: {
      ...payload,
      ts: new Date(payload.ts),
    },
  });
  status.lastSignalWrite = Date.now();
}

async function writeOutboxRow(row: { id: string; kind: string; payload: string }): Promise<void> {
  if (row.kind === 'dvolTick') {
    await writeDvol(JSON.parse(row.payload) as DvolTickPayload);
    return;
  }
  if (row.kind === 'signalSnapshot') {
    await writeSignal(JSON.parse(row.payload) as SignalSnapshotPayload);
    return;
  }
  throw new Error(`unknown durable outbox kind: ${row.kind}`);
}

export async function flushDurableBatch(): Promise<void> {
  const rows = await localPrisma.durableOutbox.findMany({
    orderBy: { createdAt: 'asc' },
    take: MAX_FLUSH_ROWS,
  });
  status.pendingOutbox = rows.length;
  if (!rows.length) {
    status.localDb = 'ok';
    status.lastFlushAt = Date.now();
    return;
  }

  const flushed: string[] = [];
  for (const row of rows) {
    try {
      await writeOutboxRow(row);
      flushed.push(row.id);
    } catch (err) {
      const msg = serialiseErr(err);
      status.durableDb = 'degraded';
      status.lastFlushError = msg;
      await localPrisma.durableOutbox.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          lastError: msg.slice(0, 500),
        },
      }).catch((localErr: unknown) => {
        status.localDb = 'degraded';
        console.error('[persist] outbox error update failed', localErr);
      });
    }
  }

  if (flushed.length) {
    await localPrisma.durableOutbox.deleteMany({
      where: { id: { in: flushed } },
    });
  }

  await pruneOutbox();
  status.durableDb = flushed.length === rows.length ? 'ok' : status.durableDb;
  status.localDb = 'ok';
  status.pendingOutbox = await localPrisma.durableOutbox.count();
  status.lastFlushAt = Date.now();
  if (status.durableDb === 'ok') status.lastFlushError = null;
}

export async function pruneOutbox(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - OUTBOX_TTL_MS);
  await localPrisma.durableOutbox.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
}

export async function refreshDurableStatus(): Promise<DurableStatus> {
  try {
    await durablePrisma.$queryRaw`SELECT 1`;
    status.durableDb = 'ok';
  } catch (err) {
    status.durableDb = 'degraded';
    status.lastFlushError = serialiseErr(err);
  }

  try {
    status.pendingOutbox = await localPrisma.durableOutbox.count();
    status.localDb = 'ok';
  } catch (err) {
    status.localDb = 'degraded';
    status.lastFlushError = serialiseErr(err);
  }

  return { ...status };
}

export function getDurableStatus(): DurableStatus {
  return { ...status };
}

export function startDurableBatcher(): void {
  setInterval(() => {
    flushDurableBatch().catch((err: unknown) => {
      status.durableDb = 'degraded';
      status.lastFlushError = serialiseErr(err);
      console.error('[persist] durable flush failed', err);
    });
  }, PERSIST_FLUSH_INTERVAL_MS);

  setTimeout(() => {
    flushDurableBatch().catch((err: unknown) => {
      status.durableDb = 'degraded';
      status.lastFlushError = serialiseErr(err);
      console.error('[persist] initial durable flush failed', err);
    });
  }, 15_000);
}
