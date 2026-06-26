import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { statfs } from 'node:fs/promises';
import { prisma } from './db.js';
import { durablePrisma } from './db/durable.js';
import { fetchBookSummary, fetchDvolLatest, fetchIndexPrice } from './deribit/rest.js';
import { DeribitWS } from './deribit/ws.js';
import { parseInstrument } from './compute/parseInstrument.js';
import {
  computeMetricsBundle,
  parseBookRows,
  buildSkewTermStructure,
  buildAtmTermStructure,
  buildExpectedMoveTable,
  computeMarketRatios,
} from './compute/metricsBundle.js';
import { filterLiquidStrikes } from './compute/liquidStrikes.js';
import { filterCurveStrikes } from './compute/curveFilter.js';
import { buildSurface } from './compute/ivSurface.js';
import { buildSurfaceByDelta } from './compute/ivSurfaceDelta.js';
import { atmIv } from './compute/atmIv.js';
import { classifyExpiration } from './compute/classifyExpiration.js';
import { expectedMoveBands } from './compute/expectedMove.js';
import { buildPanorama, buildBridgeText } from './compute/interpret/synthesis.js';
import { pickSkewTiles, pickHeadlineSkew, pickHeadlineSkew30d } from './compute/interpret/skewTiles.js';
import {
  checkFlipCross,
  checkLargeCallBlock,
  checkLargePutBlock,
  checkStructuralFear,
  checkWallApproach,
} from './compute/signals.js';
import { classifyTrade, type DeribitTrade } from './compute/tradeFlow.js';
import { flowAggregator } from './state/aggregator.js';
import { alertStream } from './state/alerts.js';
import { getDurableStatus, startDurableBatcher } from './state/durableBatcher.js';
import { getDvol, updateDvol } from './state/dvol.js';
import { getGreeks, greeksCount, greeksWithGamma, updateGreeks } from './state/greeks.js';
import { persistSignalSnapshot } from './state/signalSnapshot.js';
import { tradeStream } from './state/trades.js';
import {
  persistAggregateSnapshot,
  persistAlert,
  persistFlowTrade,
  persistDvolTick,
  persistIndexTick,
  persistMetricSnapshot,
  persistSurfaceSnapshot,
} from './state/writers.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const FLOW_STREAM_MIN_BTC = Number(process.env.FLOW_STREAM_MIN_BTC ?? 1);
const FLOW_AGG_MIN_BTC = Number(process.env.FLOW_AGG_MIN_BTC ?? 0.1);
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const OPS_ALERT_LOG_INTERVAL_MS = 5 * 60_000;

const app = express();
app.use(cors());

const dws = new DeribitWS();

// Cheap liveness probe for Fly health checks. Keep this synchronous and
// independent from DB/disk probes; /api/health remains the richer ops endpoint.
app.get('/api/live', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now() });
});

dws.onTrade((raw) => {
  const ev = classifyTrade(raw as DeribitTrade);
  if (!ev) return;

  // Aggregator gets the broader pool (≥ FLOW_AGG_MIN_BTC, default 0.1 BTC).
  // Blocks bypass the threshold — never want to miss those.
  if (ev.tag === 'block' || ev.amount >= FLOW_AGG_MIN_BTC) {
    flowAggregator.add(ev);
    // Phase 11: persist every aggregator-qualifying trade.
    persistFlowTrade(ev);
  }

  // Visual stream uses the higher threshold (≥ FLOW_STREAM_MIN_BTC,
  // default 1 BTC) so the LeftPanel feed stays clean.
  if (ev.tag === 'block' || ev.amount >= FLOW_STREAM_MIN_BTC) {
    tradeStream.push(ev);
    alertStream.push(checkLargePutBlock(ev));
    alertStream.push(checkLargeCallBlock(ev));
  }
});

// Phase 11: persist alerts on every emission (post-dedup).
alertStream.on('alert', (alert) => {
  persistAlert(alert);
});

dws.onVolatility((indexName, payload) => {
  // Deribit pushes either an object with numeric fields or a candle-ish row.
  // Defensively probe known fields in priority order.
  const value = extractDvolValue(payload);
  if (value != null) updateDvol(indexName, value);
});

function extractDvolValue(payload: unknown): number | null {
  if (typeof payload === 'number' && Number.isFinite(payload)) return payload;
  if (Array.isArray(payload)) {
    // candle: [ts, open, high, low, close]
    const close = payload[4];
    return typeof close === 'number' ? close : null;
  }
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    for (const key of ['volatility', 'value', 'close', 'estimated_delivery_price']) {
      const v = p[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

dws.onTicker((data) => {
  if (!data.instrument_name) return;
  updateGreeks(data.instrument_name, {
    delta: data.greeks?.delta,
    gamma: data.greeks?.gamma,
    vega: data.greeks?.vega,
    theta: data.greeks?.theta,
    markIv: data.mark_iv,
    markPrice: data.mark_price,
    underlyingPrice: data.underlying_price,
    openInterest: data.open_interest,
  });
});

async function refreshSubscriptions(): Promise<void> {
  try {
    const summary = await fetchBookSummary('BTC');
    const tickerChannels = summary
      .filter((row) => parseInstrument(row.instrument_name) !== null)
      .map((row) => `ticker.${row.instrument_name}.100ms`);
    await dws.subscribe([
      ...tickerChannels,
      'trades.option.BTC.100ms',
      'deribit_volatility_index.btc_usd',
    ]);
    console.log(`[dm-capital-backend] subscribed to ${dws.subscribedCount()} channels (tickers + trades)`);
  } catch (err) {
    console.error('[dm-capital-backend] refreshSubscriptions failed', err);
  }
}

interface DiskUsage {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  status: 'ok' | 'warning' | 'critical' | 'unknown';
  error?: string;
}

type OpsSeverity = 'ok' | 'warning' | 'critical';

interface OpsAlert {
  code: string;
  severity: Exclude<OpsSeverity, 'ok'>;
  message: string;
}

async function getDiskUsage(path: string): Promise<DiskUsage> {
  try {
    const stats = await statfs(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0;
    const status = usedPercent >= 85 ? 'critical' : usedPercent >= 70 ? 'warning' : 'ok';
    return { path, totalBytes, usedBytes, freeBytes, usedPercent, status };
  } catch (err) {
    return {
      path,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      status: 'unknown',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildOpsAlerts(dataDisk: DiskUsage, durable: ReturnType<typeof getDurableStatus>): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  if (dataDisk.status === 'warning' || dataDisk.status === 'critical') {
    alerts.push({
      code: 'data_disk_usage',
      severity: dataDisk.status,
      message: `/data is ${dataDisk.usedPercent}% full`,
    });
  } else if (dataDisk.status === 'unknown') {
    alerts.push({
      code: 'data_disk_unknown',
      severity: 'warning',
      message: `cannot read /data disk usage${dataDisk.error ? `: ${dataDisk.error}` : ''}`,
    });
  }

  if (durable.localDb === 'degraded') {
    alerts.push({
      code: 'local_db_degraded',
      severity: 'critical',
      message: 'local SQLite/outbox is degraded',
    });
  }

  if (durable.durableDb === 'degraded') {
    alerts.push({
      code: 'durable_db_degraded',
      severity: 'critical',
      message: durable.lastFlushError ? `durable Postgres degraded: ${durable.lastFlushError}` : 'durable Postgres degraded',
    });
  }

  const outboxAge = durable.oldestPendingOutboxAgeMs;
  const warningAgeMs = Math.max(durable.flushIntervalMs * 2, 15 * 60_000);
  const criticalAgeMs = Math.max(durable.flushIntervalMs * 6, 60 * 60_000);
  if (durable.pendingOutbox > 0 && outboxAge != null && outboxAge >= warningAgeMs) {
    alerts.push({
      code: 'pending_outbox_age',
      severity: outboxAge >= criticalAgeMs ? 'critical' : 'warning',
      message: `oldest durable outbox row is ${Math.round(outboxAge / 60_000)}m old (${durable.pendingOutbox} pending)`,
    });
  }

  return alerts;
}

let lastOpsAlertLogAt = 0;
let lastOpsAlertSignature = '';

function logOpsAlerts(alerts: OpsAlert[]): void {
  if (!alerts.length) return;
  const signature = alerts.map((alert) => `${alert.severity}:${alert.code}`).join('|');
  const now = Date.now();
  if (signature === lastOpsAlertSignature && now - lastOpsAlertLogAt < OPS_ALERT_LOG_INTERVAL_MS) return;
  lastOpsAlertSignature = signature;
  lastOpsAlertLogAt = now;
  console.warn('[ops-alert]', JSON.stringify({ ts: now, alerts }));
}

app.get('/api/health', async (_req: Request, res: Response) => {
  const dvol = getDvol('btc_usd');
  const durable = getDurableStatus();
  const dataDisk = await getDiskUsage(DATA_DIR);
  const opsAlerts = buildOpsAlerts(dataDisk, durable);
  const opsStatus: OpsSeverity = opsAlerts.some((alert) => alert.severity === 'critical')
    ? 'critical'
    : opsAlerts.length
      ? 'warning'
      : 'ok';
  logOpsAlerts(opsAlerts);
  res.json({
    ok: true,
    ts: Date.now(),
    ws: dws.isOpen(),
    subscriptions: dws.subscribedCount(),
    greeks: greeksCount(),
    greeksWithGamma: greeksWithGamma(),
    trades: tradeStream.size(),
    alerts: alertStream.size(),
    aggregatorBuckets: flowAggregator.size(),
    dvol: dvol?.value ?? null,
    dvolAge: dvol ? Date.now() - dvol.ts : null,
    durableDb: durable.durableDb,
    localDb: durable.localDb,
    pendingOutbox: durable.pendingOutbox,
    oldestPendingOutboxAt: durable.oldestPendingOutboxAt,
    oldestPendingOutboxAgeMs: durable.oldestPendingOutboxAgeMs,
    lastDvolWrite: durable.lastDvolWrite,
    lastSignalWrite: durable.lastSignalWrite,
    lastDurableFlushAt: durable.lastFlushAt,
    durableFlushIntervalMs: durable.flushIntervalMs,
    durableError: durable.lastFlushError,
    dataDisk,
    opsStatus,
    opsAlerts,
  });
});

const VALID_WINDOWS = new Set([60, 240, 1440]); // 1h, 4h, 24h in minutes

app.get('/api/history/metrics', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const expiration = typeof req.query.expiration === 'string' ? req.query.expiration : '';
    if (!expiration) {
      return res.status(400).json({ error: 'expiration query param is required' });
    }
    const hoursParam = Number(req.query.hours ?? 6);
    const hours = Number.isFinite(hoursParam) ? Math.max(1, Math.min(720, hoursParam)) : 6;
    const since = new Date(Date.now() - hours * 60 * 60_000);

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

    // Phase 11 B11.4 — explicit readiness flag so the frontend can hide
    // sparklines while the system is warming up.
    const REQUIRED_MIN_MINUTES = 60;
    const oldestMs = rows[0]?.ts.getTime() ?? Date.now();
    const minutesCollected = Math.floor((Date.now() - oldestMs) / 60_000);
    const ready = rows.length >= 6 && minutesCollected >= REQUIRED_MIN_MINUTES;

    res.json({
      currency,
      expiration,
      hours,
      ready,
      minutesCollected,
      minutesRequired: REQUIRED_MIN_MINUTES,
      points: rows.map((r) => ({
        ts: r.ts.getTime(),
        future: r.future,
        maxPain: r.maxPain,
        gammaFlip: r.gammaFlip,
        callWall: r.callWall,
        putWall: r.putWall,
        regime: r.regime,
        atmIv: r.atmIv,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/history/index', async (req: Request, res: Response) => {
  try {
    const indexName = typeof req.query.name === 'string' ? req.query.name : 'btc_usd';
    const hoursParam = Number(req.query.hours ?? 6);
    const hours = Number.isFinite(hoursParam) ? Math.max(1, Math.min(720, hoursParam)) : 6;
    const since = new Date(Date.now() - hours * 60 * 60_000);
    const rows = await durablePrisma.indexTick.findMany({
      where: { indexName, ts: { gte: since } },
      orderBy: { ts: 'asc' },
      select: { ts: true, price: true },
    });
    res.json({
      indexName,
      hours,
      points: rows.map((r) => ({ ts: r.ts.getTime(), price: r.price })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/history/export/flow.csv', async (req: Request, res: Response) => {
  try {
    const hoursParam = Number(req.query.hours ?? 24);
    const hours = Number.isFinite(hoursParam) ? Math.max(1, Math.min(720, hoursParam)) : 24;
    const since = new Date(Date.now() - hours * 60 * 60_000);

    const rows = await durablePrisma.flowTrade.findMany({
      where: { ts: { gte: since } },
      orderBy: { ts: 'asc' },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dm-capital-flow-${stamp}.csv"`);

    const header = [
      'ts_iso', 'trade_id', 'expiration', 'strike', 'type', 'side', 'tag',
      'amount_btc', 'notional_usd', 'signed_notional_usd',
      'iv', 'prior_iv', 'iv_delta', 'interp',
    ].join(',');
    res.write(header + '\n');

    for (const r of rows) {
      const cells = [
        r.ts.toISOString(),
        r.id,
        r.expiration,
        r.strike,
        r.type,
        r.side,
        r.tag,
        r.amount,
        r.notionalUsd.toFixed(2),
        r.signedNotional.toFixed(2),
        r.iv ?? '',
        r.priorIv ?? '',
        r.ivDelta ?? '',
        `"${r.interp.replace(/"/g, '""')}"`,
      ];
      res.write(cells.join(',') + '\n');
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/history/alerts', async (req: Request, res: Response) => {
  try {
    const hoursParam = Number(req.query.hours ?? 24);
    const hours = Number.isFinite(hoursParam) ? Math.max(1, Math.min(720, hoursParam)) : 24;
    const since = new Date(Date.now() - hours * 60 * 60_000);
    const rows = await durablePrisma.alertLog.findMany({
      where: { firstSeen: { gte: since } },
      orderBy: { firstSeen: 'desc' },
      take: 200,
    });
    res.json({ hours, alerts: rows });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/status/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (status: string) => {
    res.write(`event: ws-status\ndata: ${JSON.stringify({ status, ts: Date.now() })}\n\n`);
  };

  emit(dws.currentStatus());

  const handler = (status: string) => emit(status);
  dws.onStatus(handler);

  const ping = setInterval(() => res.write(': ping\n\n'), 30_000);

  req.on('close', () => {
    dws.offStatus(handler);
    clearInterval(ping);
    res.end();
  });
});

app.get('/api/synthesis', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const indexName = currency === 'BTC' ? 'btc_usd' : 'eth_usd';
    const expiration = (typeof req.query.expiration === 'string' ? req.query.expiration : '').toUpperCase();
    if (!expiration) {
      return res.status(400).json({ error: 'expiration query param is required' });
    }
    const window = String(req.query.window ?? '1h').toLowerCase();
    const windowMinutes = window === '4h' ? 240 : window === '24h' ? 1440 : 60;

    const [indexPrice, summary] = await Promise.all([
      fetchIndexPrice(indexName),
      fetchBookSummary(currency),
    ]);

    const allRows = parseBookRows(summary);
    const expRows = allRows.filter((r) => r.expiration === expiration);
    if (!expRows.length) {
      return res.status(404).json({ error: `no instruments for expiration ${expiration}` });
    }

    const bundle = computeMetricsBundle(
      allRows,
      expiration,
      'market',
      indexPrice.index_price,
    );
    if (!bundle) {
      return res.status(404).json({ error: `no instruments for expiration ${expiration}` });
    }

    const skewTermAll = buildSkewTermStructure(allRows, { maxTenors: 'all' });
    const headlineSkew = pickHeadlineSkew(skewTermAll);
    const headlineSkew30d = pickHeadlineSkew30d(skewTermAll);
    const skewTiles = pickSkewTiles(skewTermAll);

    // Net flow for the requested window
    const flowNet = flowAggregator.netForWindow(windowMinutes);

    // Next OPEX for the bridge text — first non-daily expiration
    const nextOpex = (() => {
      const all = [...new Set(allRows.map((r) => r.expiration))]
        .map((exp) => {
          const r = allRows.find((x) => x.expiration === exp);
          return r ? { expiration: exp, ts: r.expirationTimestamp } : null;
        })
        .filter((x): x is { expiration: string; ts: number } => x !== null)
        .filter((x) => x.ts > Date.now())
        .sort((a, b) => a.ts - b.ts);
      for (const e of all) {
        const tag = classifyExpiration(e.ts);
        if (tag === 'M' || tag === 'Q') return { expiration: e.expiration, tag };
      }
      return null;
    })();

    const panorama = buildPanorama({
      spot: indexPrice.index_price,
      gammaFlip: bundle.macro.gammaFlip,
      callWall: bundle.macro.callWall,
      putWall: bundle.macro.putWall,
      headlineSkew,
      signedNotional: flowNet.signedNotional,
      deltaFlowUsd: flowNet.deltaFlowUsd,
    });

    const bridgeText = buildBridgeText(bundle.macro.callWall, bundle.macro.putWall, nextOpex);

    res.json({
      currency,
      expiration,
      window,
      fetchedAt: Date.now(),
      spot: indexPrice.index_price,
      future: bundle.future,
      macro: bundle.macro,
      panorama,
      bridgeText,
      skewTiles,
      headlineSkew,
      headlineSkew30d,
      flowNet: {
        window,
        signedNotional: flowNet.signedNotional,
        deltaFlowUsd: flowNet.deltaFlowUsd,
        deltaCount: flowNet.deltaCount,
        vegaFlowUsd: flowNet.vegaFlowUsd,
        vegaCount: flowNet.vegaCount,
        bucketsUsed: flowNet.bucketsUsed,
      },
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/flow/net', (req: Request, res: Response) => {
  const windowParam = String(req.query.window ?? '1h').toLowerCase();
  const windowMinutes = windowParam === '4h' ? 240 : windowParam === '24h' ? 1440 : 60;
  if (!VALID_WINDOWS.has(windowMinutes)) {
    return res.status(400).json({ error: 'window must be one of 1h, 4h, 24h' });
  }
  const result = flowAggregator.netForWindow(windowMinutes);
  res.json({
    window: windowParam,
    fetchedAt: Date.now(),
    points: flowAggregator.seriesForWindow(windowMinutes),
    ...result,
  });
});

app.get('/api/dvol', (_req: Request, res: Response) => {
  const snap = getDvol('btc_usd');
  if (!snap) {
    return res.status(503).json({ error: 'dvol warming up' });
  }
  res.json({ value: snap.value, ts: snap.ts, indexName: 'btc_usd' });
});

const DVOL_HISTORY_WINDOWS: Record<string, number> = {
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '365d': 365 * 24 * 60 * 60_000,
};

app.get('/api/dvol/history', async (req: Request, res: Response) => {
  try {
    const windowParam = typeof req.query.window === 'string' ? req.query.window : '24h';
    const windowMs = DVOL_HISTORY_WINDOWS[windowParam] ?? DVOL_HISTORY_WINDOWS['24h'];
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const since = new Date(Date.now() - windowMs);

    const rows = await durablePrisma.dvolTick.findMany({
      where: { currency, ts: { gte: since } },
      orderBy: { ts: 'asc' },
      select: { ts: true, value: true },
    });

    res.json({
      currency,
      window: windowParam in DVOL_HISTORY_WINDOWS ? windowParam : '24h',
      fetchedAt: Date.now(),
      points: rows.map((r) => ({ ts: r.ts.getTime(), value: r.value })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/dvol/rank', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const live = getDvol('btc_usd');
    const current = live?.value ?? null;
    const since = new Date(Date.now() - DVOL_HISTORY_WINDOWS['365d']);

    const rows = await durablePrisma.dvolTick.findMany({
      where: { currency, ts: { gte: since } },
      orderBy: { ts: 'asc' },
      select: { ts: true, value: true },
    });

    if (current == null || !rows.length) {
      return res.json({
        currency,
        current,
        percentile: null,
        samplePoints: rows.length,
        sampleDays: rows.length >= 2
          ? (rows[rows.length - 1].ts.getTime() - rows[0].ts.getTime()) / 86_400_000
          : 0,
        ready: false,
        fetchedAt: Date.now(),
      });
    }

    const values = rows.map((r) => r.value);
    const belowOrEqual = values.filter((v) => v <= current).length;
    const percentile = (belowOrEqual / values.length) * 100;
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];

    res.json({
      currency,
      current,
      percentile,
      samplePoints: values.length,
      sampleDays:
        (rows[rows.length - 1].ts.getTime() - rows[0].ts.getTime()) / 86_400_000,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p10: pick(0.1),
      p50: pick(0.5),
      p90: pick(0.9),
      ready: values.length >= 60,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/expected-move/daily', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const indexName = currency === 'BTC' ? 'btc_usd' : 'eth_usd';

    const [indexPrice, summary] = await Promise.all([
      fetchIndexPrice(indexName),
      fetchBookSummary(currency),
    ]);

    const now = Date.now();
    const rows = summary
      .map((row) => {
        const p = parseInstrument(row.instrument_name);
        if (!p || p.expirationTimestamp <= now) return null;
        return {
          ...p,
          markIv: row.mark_iv ?? 0,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (!rows.length) {
      return res.status(503).json({ error: 'no future expirations available' });
    }

    // Pick the nearest expiration. For the 1-day horizon, the nearest
    // expiration's ATM IV is the cleanest market-implied volatility for today.
    rows.sort((a, b) => a.expirationTimestamp - b.expirationTimestamp);
    const frontExp = rows[0].expiration;
    const frontRows = rows.filter((r) => r.expiration === frontExp);
    const forward = summary.find((s) => parseInstrument(s.instrument_name)?.expiration === frontExp)
      ?.underlying_price ?? indexPrice.index_price;

    const atm = atmIv(frontRows, forward);
    if (atm == null) {
      return res.status(503).json({ error: 'atm iv not available' });
    }

    const bands = expectedMoveBands(forward, atm, 1);
    res.json({
      ...bands,
      expiration: frontExp,
      forward,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/expected-move/table', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const indexName = currency === 'BTC' ? 'btc_usd' : 'eth_usd';
    const [indexPrice, summary] = await Promise.all([
      fetchIndexPrice(indexName),
      fetchBookSummary(currency),
    ]);
    const allRows = parseBookRows(summary);
    const rows = buildExpectedMoveTable(allRows, indexPrice.index_price);
    res.json({
      currency,
      spot: indexPrice.index_price,
      rows,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/totals', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const indexName = currency === 'BTC' ? 'btc_usd' : 'eth_usd';
    const [indexPrice, data] = await Promise.all([
      fetchIndexPrice(indexName),
      fetchBookSummary(currency),
    ]);
    let notionalUsd = 0;
    let contracts = 0;
    for (const row of data) {
      const oi = row.open_interest ?? 0;
      const px = row.underlying_price ?? 0;
      contracts += oi;
      notionalUsd += oi * px;
    }
    const allRows = parseBookRows(data);
    const ratios = computeMarketRatios(allRows, indexPrice.index_price);
    res.json({
      currency,
      contracts,
      notionalUsd,
      instrumentCount: data.length,
      ...ratios,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/flow', (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
  res.json({ trades: tradeStream.recent(limit) });
});

app.get('/api/flow/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // backfill recent
  const recent = tradeStream.recent(20).slice().reverse();
  for (const ev of recent) {
    res.write(`event: trade\ndata: ${JSON.stringify(ev)}\n\n`);
  }

  const onTrade = (ev: unknown) => {
    res.write(`event: trade\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  tradeStream.on('trade', onTrade);

  const ping = setInterval(() => res.write(': ping\n\n'), 30_000);

  req.on('close', () => {
    tradeStream.off('trade', onTrade);
    clearInterval(ping);
    res.end();
  });
});

app.get('/api/index', async (req: Request, res: Response) => {
  try {
    const indexName = typeof req.query.name === 'string' ? req.query.name : 'btc_usd';
    const data = await fetchIndexPrice(indexName);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/options', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const data = await fetchBookSummary(currency);
    res.json({
      currency,
      count: data.length,
      fetchedAt: Date.now(),
      instruments: data,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/expirations', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const data = await fetchBookSummary(currency);

    // Aggregate per expiration: timestamp, notional (Σ OI × underlying_price), counts
    interface Agg {
      timestamp: number;
      notionalUsd: number;
      contracts: number;
      count: number;
    }
    const agg = new Map<string, Agg>();
    for (const row of data) {
      const p = parseInstrument(row.instrument_name);
      if (!p) continue;
      const bucket = agg.get(p.expiration) ?? {
        timestamp: p.expirationTimestamp,
        notionalUsd: 0,
        contracts: 0,
        count: 0,
      };
      bucket.contracts += row.open_interest ?? 0;
      bucket.notionalUsd += (row.open_interest ?? 0) * (row.underlying_price ?? 0);
      bucket.count += 1;
      agg.set(p.expiration, bucket);
    }

    const now = Date.now();
    const list = [...agg.entries()]
      .filter(([, a]) => a.timestamp > now)
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .map(([expiration, a]) => ({
        expiration,
        timestamp: a.timestamp,
        tag: classifyExpiration(a.timestamp),
        notionalUsd: a.notionalUsd,
        contracts: a.contracts,
        count: a.count,
      }));

    res.json({ currency, expirations: list });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/metrics', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const indexName = currency === 'BTC' ? 'btc_usd' : 'eth_usd';
    const expiration = (typeof req.query.expiration === 'string' ? req.query.expiration : '').toUpperCase();
    if (!expiration) {
      return res.status(400).json({ error: 'expiration query param is required' });
    }
    const scopeParam = String(req.query.scope ?? 'market').toLowerCase();
    const scope = scopeParam === 'expiration' ? 'expiration' : 'market';

    const [indexPrice, data] = await Promise.all([
      fetchIndexPrice(indexName),
      fetchBookSummary(currency),
    ]);

    const allRows = parseBookRows(data);
    const bundle = computeMetricsBundle(
      allRows,
      expiration,
      scope,
      indexPrice.index_price,
    );
    if (!bundle) {
      return res.status(404).json({ error: `no instruments for expiration ${expiration}` });
    }

    const expiryLevels = computeMetricsBundle(
      allRows,
      expiration,
      'expiration',
      indexPrice.index_price,
    );

    alertStream.push(checkFlipCross(expiration, bundle.future, expiryLevels?.gammaFlip ?? null));
    alertStream.push(
      checkWallApproach(
        expiration,
        bundle.future,
        expiryLevels?.local.resistance ?? null,
        expiryLevels?.local.support ?? null,
      ),
    );

    res.json({
      currency,
      expiration,
      scope: bundle.scope,
      fetchedAt: Date.now(),
      future: bundle.future,
      count: bundle.count,
      maxPain: bundle.maxPain,
      oi: bundle.oi,
      volume: bundle.volume,
      volOi: bundle.volOi,
      keyStrikes: bundle.keyStrikes,
      ivCurve: bundle.ivCurve,
      gex: bundle.gex,
      dex: bundle.dex,
      dexSummary: bundle.dexSummary,
      vex: bundle.vex,
      vexSummary: bundle.vexSummary,
      gexCovered: bundle.gexCovered,
      dexCovered: bundle.dexCovered,
      vexCovered: bundle.vexCovered,
      gammaFlip: bundle.gammaFlip,
      callWall: bundle.callWall,
      putWall: bundle.putWall,
      regime: bundle.regime,
      expectedMove: bundle.expectedMove,
      macro: bundle.macro,
      local: bundle.local,
      walls: bundle.walls,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/surface', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const tenors = Math.max(2, Math.min(8, Number(req.query.tenors ?? 8)));
    const axis = req.query.axis === 'delta' ? 'delta' : 'strike';

    const data = await fetchBookSummary(currency);
    const allRows = parseBookRows(data);
    const liquid = filterLiquidStrikes(allRows);
    const curveLiquid = filterCurveStrikes(liquid);
    const surfaceInput = curveLiquid.map((r) => ({
      instrument: r.instrument,
      strike: r.strike,
      type: r.type,
      markIv: r.markIv,
      expiration: r.expiration,
      expirationTimestamp: r.expirationTimestamp,
      underlyingPrice: r.underlyingPrice,
      interestRate: r.interestRate,
    }));

    const termStructure = buildSkewTermStructure(allRows, {
      maxTenors: 'all',
      excludeZeroDte: true,
    });
    const atmTermStructure = buildAtmTermStructure(allRows);

    // Phase 5: structural-fear rule
    alertStream.push(checkStructuralFear(termStructure));

    const shared = {
      currency,
      fetchedAt: Date.now(),
      axis,
      termStructure,
      atmTermStructure,
      headlineSkew: pickHeadlineSkew(termStructure),
      headlineSkew30d: pickHeadlineSkew30d(
        buildSkewTermStructure(allRows, { maxTenors: 'all' }),
      ),
    };

    if (axis === 'delta') {
      const surface = buildSurfaceByDelta(surfaceInput, tenors);
      res.json({
        ...shared,
        deltas: surface.columns.map((c) => c.index),
        deltaColumns: surface.columns.map(({ rawDelta, label, hoverLabel }) => ({
          rawDelta,
          label,
          hoverLabel,
        })),
        strikes: [],
        expirations: surface.rows.map((sr) => ({
          expiration: sr.expiration,
          timestamp: sr.expirationTimestamp,
          tenorDays: sr.tenorDays,
        })),
        iv: surface.rows.map((sr) => sr.iv),
      });
      return;
    }

    const surface = buildSurface(surfaceInput, tenors);
    res.json({
      ...shared,
      strikes: surface.strikes,
      deltas: [],
      expirations: surface.rows.map((sr) => ({
        expiration: sr.expiration,
        timestamp: sr.expirationTimestamp,
        tenorDays: sr.tenorDays,
      })),
      iv: surface.rows.map((sr) => sr.iv),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/alerts', (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)));
  res.json({ alerts: alertStream.recent(limit) });
});

app.get('/api/alerts/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  for (const a of alertStream.recent(10).slice().reverse()) {
    res.write(`event: alert\ndata: ${JSON.stringify(a)}\n\n`);
  }

  const onAlert = (a: unknown) => {
    res.write(`event: alert\ndata: ${JSON.stringify(a)}\n\n`);
  };
  alertStream.on('alert', onAlert);

  const ping = setInterval(() => res.write(': ping\n\n'), 30_000);

  req.on('close', () => {
    alertStream.off('alert', onAlert);
    clearInterval(ping);
    res.end();
  });
});

app.listen(PORT, HOST, async () => {
  console.log(`[dm-capital-backend] listening on http://${HOST}:${PORT}`);
  try {
    await dws.connect();
    await refreshSubscriptions();
    setInterval(refreshSubscriptions, 5 * 60 * 1000);

    // DVOL bootstrap from REST so the header has a value immediately.
    fetchDvolLatest('BTC').then((v) => {
      if (v != null) {
        updateDvol('btc_usd', v);
        console.log(`[dm-capital-backend] DVOL bootstrapped at ${v.toFixed(2)}%`);
      }
    }).catch((err) => console.error('[dm-capital-backend] DVOL bootstrap failed', err));

    // Phase 11: restore last aggregator snapshot if it exists (B8.3 fix).
    try {
      const lastSnap = await prisma.flowAggregateSnapshot.findFirst({
        orderBy: { ts: 'desc' },
      });
      if (lastSnap) {
        const parsed = JSON.parse(lastSnap.buckets) as Record<string, { signedNotional: number; buyCount: number; sellCount: number }>;
        flowAggregator.restoreBuckets(parsed);
        console.log(`[dm-capital-backend] restored ${Object.keys(parsed).length} aggregator buckets from snapshot ${lastSnap.ts.toISOString()}`);
      }
    } catch (err) {
      console.error('[dm-capital-backend] aggregator restore failed', err);
    }

    startPersistenceTimers();
  } catch (err) {
    console.error('[dm-capital-backend] ws bootstrap failed', err);
  }
});

// =============================================================================
// Phase 11 · Persistence timers
// =============================================================================

const RETENTION_DAYS = Number(process.env.HISTORY_RETENTION_DAYS ?? 90);
const DVOL_RETENTION_DAYS = Number(process.env.DVOL_RETENTION_DAYS ?? 365);
const FLOW_TRADE_RETENTION_DAYS = Number(process.env.FLOW_TRADE_RETENTION_DAYS ?? 30);
const FLOW_AGGREGATE_RETENTION_HOURS = Number(process.env.FLOW_AGGREGATE_RETENTION_HOURS ?? 48);

async function snapshotIndexTick(): Promise<void> {
  try {
    const idx = await fetchIndexPrice('btc_usd');
    persistIndexTick(idx.index_price, 'btc_usd');
  } catch (err) {
    console.error('[persist] indexTick fetch failed', err);
  }
}

async function snapshotAllMetrics(): Promise<void> {
  try {
    const [data, indexPrice] = await Promise.all([
      fetchBookSummary('BTC'),
      fetchIndexPrice('btc_usd'),
    ]);
    const allRows = parseBookRows(data);
    const ts = new Date();
    const expirations = [...new Set(allRows.map((r) => r.expiration))];

    for (const expiration of expirations) {
      const bundle = computeMetricsBundle(
        allRows,
        expiration,
        'expiration',
        indexPrice.index_price,
        ts.getTime(),
      );
      if (!bundle) continue;

      persistMetricSnapshot({
        ts,
        currency: 'BTC',
        expiration,
        future: bundle.future,
        maxPain: bundle.maxPain,
        gammaFlip: bundle.gammaFlip,
        callWall: bundle.callWall,
        putWall: bundle.putWall,
        regime: bundle.regime,
        oi: bundle.oi,
        gex: bundle.gex,
        atmIv: atmIv(filterLiquidStrikes(allRows.filter((r) => r.expiration === expiration)), bundle.future),
        count: bundle.count,
        gexCovered: bundle.gexCovered,
      });
    }
  } catch (err) {
    console.error('[persist] metric snapshot batch failed', err);
  }
}

async function snapshotSurface(): Promise<void> {
  try {
    const data = await fetchBookSummary('BTC');
    const allRows = parseBookRows(data);
    const termStructure = buildSkewTermStructure(allRows, { maxTenors: 'all' });
    persistSurfaceSnapshot({
      ts: new Date(),
      currency: 'BTC',
      headlineSkew: pickHeadlineSkew(termStructure),
      termStructure,
    });
  } catch (err) {
    console.error('[persist] surface snapshot failed', err);
  }
}

async function snapshotDvolTick(): Promise<void> {
  const snap = getDvol('btc_usd');
  if (!snap) return;
  persistDvolTick(snap.value, 'BTC', new Date(snap.ts));
}

async function snapshotSignal(): Promise<void> {
  try {
    const [data, indexPrice] = await Promise.all([
      fetchBookSummary('BTC'),
      fetchIndexPrice('btc_usd'),
    ]);
    persistSignalSnapshot(data, indexPrice.index_price);
  } catch (err) {
    console.error('[persist] signal snapshot failed', err);
  }
}

async function pruneOldHistory(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const dvolCutoff = new Date(Date.now() - DVOL_RETENTION_DAYS * 86_400_000);
  const flowTradeCutoff = new Date(Date.now() - FLOW_TRADE_RETENTION_DAYS * 86_400_000);
  const aggregateCutoff = new Date(Date.now() - FLOW_AGGREGATE_RETENTION_HOURS * 60 * 60_000);
  try {
    const [
      legacyMetrics,
      legacySurface,
      legacyTrades,
      legacyAlerts,
      legacyTicks,
      aggs,
      legacyDvol,
      durableMetrics,
      durableSurface,
      durableTrades,
      durableAlerts,
      durableTicks,
      durableDvol,
    ] = await Promise.all([
      // SQLite is now cache/outbox only. Clear legacy historical tables entirely.
      prisma.metricSnapshot.deleteMany({}),
      prisma.surfaceSnapshot.deleteMany({}),
      prisma.flowTrade.deleteMany({}),
      prisma.alertLog.deleteMany({}),
      prisma.indexTick.deleteMany({}),
      prisma.flowAggregateSnapshot.deleteMany({ where: { ts: { lt: aggregateCutoff } } }),
      prisma.dvolTick.deleteMany({}),
      durablePrisma.metricSnapshot.deleteMany({ where: { ts: { lt: cutoff } } }),
      durablePrisma.surfaceSnapshot.deleteMany({ where: { ts: { lt: cutoff } } }),
      durablePrisma.flowTrade.deleteMany({ where: { ts: { lt: flowTradeCutoff } } }),
      durablePrisma.alertLog.deleteMany({ where: { firstSeen: { lt: cutoff } } }),
      durablePrisma.indexTick.deleteMany({ where: { ts: { lt: cutoff } } }),
      durablePrisma.dvolTick.deleteMany({ where: { ts: { lt: dvolCutoff } } }),
    ]);
    console.log(
      `[persist] pruned durable ${RETENTION_DAYS}d: metrics=${durableMetrics.count} surface=${durableSurface.count} alerts=${durableAlerts.count} ticks=${durableTicks.count} · durable flow ${FLOW_TRADE_RETENTION_DAYS}d=${durableTrades.count} · durable dvol ${DVOL_RETENTION_DAYS}d=${durableDvol.count} · sqlite legacy cleared: metrics=${legacyMetrics.count} surface=${legacySurface.count} trades=${legacyTrades.count} alerts=${legacyAlerts.count} ticks=${legacyTicks.count} dvol=${legacyDvol.count} · aggregate ${FLOW_AGGREGATE_RETENTION_HOURS}h=${aggs.count}`,
    );
  } catch (err) {
    console.error('[persist] prune failed', err);
  }
}

function startPersistenceTimers(): void {
  startDurableBatcher();

  // IndexTick — every 30s (D11.1 audit grain)
  setInterval(snapshotIndexTick, 30_000);
  snapshotIndexTick();

  // MetricSnapshot per expiration — every 5min (D11.1 byte-exact replay grain)
  setInterval(snapshotAllMetrics, 5 * 60_000);
  setTimeout(snapshotAllMetrics, 10_000); // first snapshot after warmup

  // SurfaceSnapshot — every 5min
  setInterval(snapshotSurface, 5 * 60_000);
  setTimeout(snapshotSurface, 15_000);

  // FlowAggregateSnapshot — every 60s (B8.3 restart-recovery)
  setInterval(() => persistAggregateSnapshot(flowAggregator.snapshotBuckets()), 60_000);

  // DvolTick — every 60s (1/min grain)
  setInterval(snapshotDvolTick, 60_000);
  setTimeout(snapshotDvolTick, 5_000);

  // SignalSnapshot — every 60s capture, durable flush is batched separately.
  setInterval(snapshotSignal, 60_000);
  setTimeout(snapshotSignal, 20_000);

  // Prune retention — daily
  setInterval(pruneOldHistory, 24 * 60 * 60_000);
  setTimeout(pruneOldHistory, 60_000);

  console.log('[persist] timers started: indexTick=30s · dvol=60s · signal=60s · metric/surface=5m · aggregate=60s · prune=24h');
}
