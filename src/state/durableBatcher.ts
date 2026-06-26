import { durablePrisma } from '../db/durable.js';
import { Prisma } from '../generated/durable-client/index.js';
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

type DurableKind =
  | 'dvolTick'
  | 'signalSnapshot'
  | 'metricSnapshot'
  | 'surfaceSnapshot'
  | 'flowTrade'
  | 'alertLog'
  | 'indexTick';

export interface DurableStatus {
  durableDb: 'ok' | 'degraded' | 'unknown';
  localDb: 'ok' | 'degraded' | 'unknown';
  pendingOutbox: number;
  oldestPendingOutboxAt: number | null;
  oldestPendingOutboxAgeMs: number | null;
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
  vexNet: number | null;
  flowDeltaNet: number | null;
  flowVegaNet: number | null;
  flowPremiumNet: number | null;
  regimeLabel: string | null;
}

export interface MetricSnapshotPayload {
  ts: number;
  currency: string;
  expiration: string;
  future: number;
  maxPain: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  regime: string;
  oiSummary: Prisma.InputJsonValue;
  gexSummary: Prisma.InputJsonValue;
  atmIv: number | null;
  count: number;
  gexCovered: number;
}

export interface SurfaceSnapshotPayload {
  ts: number;
  currency: string;
  headlineSkew: number | null;
  termStructure: Prisma.InputJsonValue;
}

export interface FlowTradePayload {
  id: string;
  ts: number;
  expiration: string;
  strike: number;
  type: string;
  side: string;
  tag: string;
  amount: number;
  notionalUsd: number;
  signedNotional: number;
  iv: number | null;
  priorIv: number | null;
  ivDelta: number | null;
  interp: string;
}

export interface AlertLogPayload {
  id: string;
  firstSeen: number;
  kind: string;
  severity: string;
  title: string;
  message: string;
  contextJson: Prisma.InputJsonValue | null;
}

export interface IndexTickPayload {
  ts: number;
  indexName: string;
  price: number;
}

interface OutboxPayloads {
  dvolTick: DvolTickPayload;
  signalSnapshot: SignalSnapshotPayload;
  metricSnapshot: MetricSnapshotPayload;
  surfaceSnapshot: SurfaceSnapshotPayload;
  flowTrade: FlowTradePayload;
  alertLog: AlertLogPayload;
  indexTick: IndexTickPayload;
}

const status: DurableStatus = {
  durableDb: 'unknown',
  localDb: 'unknown',
  pendingOutbox: 0,
  oldestPendingOutboxAt: null,
  oldestPendingOutboxAgeMs: null,
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

function outboxId<K extends DurableKind>(kind: K, payload: OutboxPayloads[K]): string {
  if (kind === 'flowTrade') {
    return `${kind}:${(payload as FlowTradePayload).id}`;
  }
  if (kind === 'alertLog') {
    return `${kind}:${(payload as AlertLogPayload).id}`;
  }
  if (kind === 'indexTick') {
    const index = payload as IndexTickPayload;
    return `${kind}:${index.indexName}:${index.ts}`;
  }
  if (kind === 'metricSnapshot') {
    const metric = payload as MetricSnapshotPayload;
    return `${kind}:${metric.currency}:${metric.expiration}:${metric.ts}`;
  }
  if (kind === 'surfaceSnapshot') {
    const surface = payload as SurfaceSnapshotPayload;
    return `${kind}:${surface.currency}:${surface.ts}`;
  }
  const durable = payload as DvolTickPayload | SignalSnapshotPayload;
  return `${kind}:${durable.currency}:${durable.ts}`;
}

async function enqueue<K extends DurableKind>(
  kind: K,
  payload: OutboxPayloads[K],
): Promise<void> {
  const id = outboxId(kind, payload);
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
  status.pendingOutbox += 1;
  status.oldestPendingOutboxAt ??= Date.now();
  status.oldestPendingOutboxAgeMs = status.oldestPendingOutboxAt == null ? null : Date.now() - status.oldestPendingOutboxAt;
}

async function refreshOutboxStatus(): Promise<void> {
  const [pendingOutbox, oldest] = await Promise.all([
    localPrisma.durableOutbox.count(),
    localPrisma.durableOutbox.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  const oldestPendingOutboxAt = oldest?.createdAt.getTime() ?? null;
  status.pendingOutbox = pendingOutbox;
  status.oldestPendingOutboxAt = oldestPendingOutboxAt;
  status.oldestPendingOutboxAgeMs = oldestPendingOutboxAt == null ? null : Date.now() - oldestPendingOutboxAt;
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

export function enqueueMetricSnapshot(payload: MetricSnapshotPayload): void {
  enqueue('metricSnapshot', payload).catch((err: unknown) => {
    status.localDb = 'degraded';
    console.error('[persist] metricSnapshot outbox failed', err);
  });
}

export function enqueueSurfaceSnapshot(payload: SurfaceSnapshotPayload): void {
  enqueue('surfaceSnapshot', payload).catch((err: unknown) => {
    status.localDb = 'degraded';
    console.error('[persist] surfaceSnapshot outbox failed', err);
  });
}

export function enqueueFlowTrade(payload: FlowTradePayload): void {
  enqueue('flowTrade', payload).catch((err: unknown) => {
    status.localDb = 'degraded';
    console.error('[persist] flowTrade outbox failed', err);
  });
}

export function enqueueAlertLog(payload: AlertLogPayload): void {
  enqueue('alertLog', payload).catch((err: unknown) => {
    status.localDb = 'degraded';
    console.error('[persist] alertLog outbox failed', err);
  });
}

export function enqueueIndexTick(payload: IndexTickPayload): void {
  enqueue('indexTick', payload).catch((err: unknown) => {
    status.localDb = 'degraded';
    console.error('[persist] indexTick outbox failed', err);
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

async function writeMetric(payload: MetricSnapshotPayload): Promise<void> {
  await durablePrisma.metricSnapshot.create({
    data: {
      ...payload,
      ts: new Date(payload.ts),
    },
  });
}

async function writeSurface(payload: SurfaceSnapshotPayload): Promise<void> {
  await durablePrisma.surfaceSnapshot.create({
    data: {
      ...payload,
      ts: new Date(payload.ts),
    },
  });
}

async function writeFlowTrade(payload: FlowTradePayload): Promise<void> {
  // id is the Deribit trade_id. On reconnect Deribit replays recent trades, so
  // duplicates are expected — upsert lets Postgres no-op on conflict instead of
  // raising a unique-constraint error that Prisma would log as noise.
  await durablePrisma.flowTrade.upsert({
    where: { id: payload.id },
    create: {
      ...payload,
      ts: new Date(payload.ts),
    },
    update: {},
  });
}

async function writeAlert(payload: AlertLogPayload): Promise<void> {
  await durablePrisma.alertLog.upsert({
    where: { id: payload.id },
    create: {
      ...payload,
      firstSeen: new Date(payload.firstSeen),
      contextJson: payload.contextJson ?? Prisma.JsonNull,
    },
    update: {},
  });
}

async function writeIndexTick(payload: IndexTickPayload): Promise<void> {
  await durablePrisma.indexTick.upsert({
    where: { ts_indexName: { ts: new Date(payload.ts), indexName: payload.indexName } },
    create: {
      ...payload,
      ts: new Date(payload.ts),
    },
    update: {
      price: payload.price,
    },
  });
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
  if (row.kind === 'metricSnapshot') {
    await writeMetric(JSON.parse(row.payload) as MetricSnapshotPayload);
    return;
  }
  if (row.kind === 'surfaceSnapshot') {
    await writeSurface(JSON.parse(row.payload) as SurfaceSnapshotPayload);
    return;
  }
  if (row.kind === 'flowTrade') {
    await writeFlowTrade(JSON.parse(row.payload) as FlowTradePayload);
    return;
  }
  if (row.kind === 'alertLog') {
    await writeAlert(JSON.parse(row.payload) as AlertLogPayload);
    return;
  }
  if (row.kind === 'indexTick') {
    await writeIndexTick(JSON.parse(row.payload) as IndexTickPayload);
    return;
  }
  throw new Error(`unknown durable outbox kind: ${row.kind}`);
}

export async function flushDurableBatch(): Promise<void> {
  const rows = await localPrisma.durableOutbox.findMany({
    orderBy: { createdAt: 'asc' },
    take: MAX_FLUSH_ROWS,
  });
  if (!rows.length) {
    status.localDb = 'ok';
    await refreshOutboxStatus();
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
  await refreshOutboxStatus();
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
    await refreshOutboxStatus();
    status.localDb = 'ok';
  } catch (err) {
    status.localDb = 'degraded';
    status.lastFlushError = serialiseErr(err);
  }

  return { ...status };
}

export function getDurableStatus(): DurableStatus {
  return {
    ...status,
    oldestPendingOutboxAgeMs: status.oldestPendingOutboxAt == null ? null : Date.now() - status.oldestPendingOutboxAt,
  };
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
