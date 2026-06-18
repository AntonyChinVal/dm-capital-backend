import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { prisma } from './db.js';
import { fetchBookSummary, fetchDvolLatest, fetchIndexPrice } from './deribit/rest.js';
import { DeribitWS } from './deribit/ws.js';
import { parseInstrument } from './compute/parseInstrument.js';
import { ivCurve } from './compute/iv.js';
import { maxPain, oiByStrike } from './compute/oi.js';
import { gexByStrike, regimeReport } from './compute/gex.js';
import { buildSurface } from './compute/ivSurface.js';
import { skew25d } from './compute/skew.js';
import { atmIv } from './compute/atmIv.js';
import { classifyExpiration } from './compute/classifyExpiration.js';
import { expectedMoveBands } from './compute/expectedMove.js';
import { buildPanorama, buildBridgeText } from './compute/interpret/synthesis.js';
import { pickSkewTiles } from './compute/interpret/skewTiles.js';
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
import { getDvol, updateDvol } from './state/dvol.js';
import { getGreeks, greeksCount, greeksWithGamma, updateGreeks } from './state/greeks.js';
import { tradeStream } from './state/trades.js';
import {
  persistAggregateSnapshot,
  persistAlert,
  persistFlowTrade,
  persistIndexTick,
  persistMetricSnapshot,
  persistSurfaceSnapshot,
} from './state/writers.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const FLOW_STREAM_MIN_BTC = Number(process.env.FLOW_STREAM_MIN_BTC ?? 1);
const FLOW_AGG_MIN_BTC = Number(process.env.FLOW_AGG_MIN_BTC ?? 0.1);

const app = express();
app.use(cors());

const dws = new DeribitWS();

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

app.get('/api/health', (_req: Request, res: Response) => {
  const dvol = getDvol('btc_usd');
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
    const rows = await prisma.indexTick.findMany({
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

    const rows = await prisma.flowTrade.findMany({
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
    const rows = await prisma.alertLog.findMany({
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

    const rows = summary
      .map((row) => {
        const p = parseInstrument(row.instrument_name);
        if (!p) return null;
        return {
          ...p,
          openInterest: row.open_interest,
          markIv: row.mark_iv ?? 0,
          underlyingPrice: row.underlying_price,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const expRows = rows.filter((r) => r.expiration === expiration);
    if (!expRows.length) {
      return res.status(404).json({ error: `no instruments for expiration ${expiration}` });
    }

    // Replicate the minimal compute path from /api/metrics — keep them in sync.
    const future = expRows[0].underlyingPrice;
    const oi = oiByStrike(expRows);
    const gexRows = expRows
      .map((r) => {
        const g = getGreeks(r.instrument);
        return g?.gamma != null && Number.isFinite(g.gamma)
          ? { strike: r.strike, type: r.type, openInterest: r.openInterest, gamma: g.gamma }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const gex = gexByStrike(gexRows, future);
    const levels = regimeReport(gex, future);

    // Surface for headline skew + skew tiles
    const futureRows = rows
      .filter((r) => r.expirationTimestamp > Date.now())
      .map((r) => ({
        instrument: r.instrument,
        strike: r.strike,
        type: r.type,
        markIv: r.markIv,
        expiration: r.expiration,
        expirationTimestamp: r.expirationTimestamp,
      }));
    const surface = buildSurface(futureRows, 6);
    const termStructure = surface.rows.map((sr) => {
      const sr_rows = futureRows.filter((r) => r.expiration === sr.expiration);
      const sk = skew25d(sr_rows);
      return {
        expiration: sr.expiration,
        tenorDays: sr.tenorDays,
        skew25d: sk.skew25d,
      };
    });
    const headlineSkew = termStructure[0]?.skew25d ?? null;
    const skewTiles = pickSkewTiles(termStructure);

    // Net flow for the requested window
    const flowNet = flowAggregator.netForWindow(windowMinutes);

    // Next OPEX for the bridge text — first non-daily expiration
    const nextOpex = (() => {
      const all = [...new Set(rows.map((r) => r.expiration))]
        .map((exp) => {
          const r = rows.find((x) => x.expiration === exp);
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
      gammaFlip: levels.gammaFlip,
      callWall: levels.callWall,
      putWall: levels.putWall,
      headlineSkew,
      signedNotional: flowNet.signedNotional,
    });

    const bridgeText = buildBridgeText(levels.callWall, levels.putWall, nextOpex);

    res.json({
      currency,
      expiration,
      window,
      fetchedAt: Date.now(),
      spot: indexPrice.index_price,
      future,
      panorama,
      bridgeText,
      skewTiles,
      headlineSkew,
      flowNet: {
        window,
        signedNotional: flowNet.signedNotional,
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

    const bands = expectedMoveBands(indexPrice.index_price, atm, 1);
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

app.get('/api/totals', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const data = await fetchBookSummary(currency);
    let notionalUsd = 0;
    let contracts = 0;
    for (const row of data) {
      const oi = row.open_interest ?? 0;
      const px = row.underlying_price ?? 0;
      contracts += oi;
      notionalUsd += oi * px;
    }
    res.json({
      currency,
      contracts,
      notionalUsd,
      instrumentCount: data.length,
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
    const expiration = (typeof req.query.expiration === 'string' ? req.query.expiration : '').toUpperCase();
    if (!expiration) {
      return res.status(400).json({ error: 'expiration query param is required' });
    }

    const data = await fetchBookSummary(currency);

    const rows = data
      .map((row) => {
        const p = parseInstrument(row.instrument_name);
        if (!p) return null;
        return {
          ...p,
          openInterest: row.open_interest,
          markIv: row.mark_iv ?? 0,
          underlyingPrice: row.underlying_price,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && r.expiration === expiration);

    if (!rows.length) {
      return res.status(404).json({ error: `no instruments for expiration ${expiration}` });
    }

    const future = rows[0].underlyingPrice;
    const oi = oiByStrike(rows);
    const mp = maxPain(oi);
    const iv = ivCurve(rows);

    // GEX from WS-fed greeks store
    const gexRows = rows
      .map((r) => {
        const g = getGreeks(r.instrument);
        return g?.gamma != null && Number.isFinite(g.gamma)
          ? {
              strike: r.strike,
              type: r.type,
              openInterest: r.openInterest,
              gamma: g.gamma,
            }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const gex = gexByStrike(gexRows, future);
    const levels = regimeReport(gex, future);

    // Phase 5: signal rules tied to metrics computation
    alertStream.push(checkFlipCross(expiration, future, levels.gammaFlip));
    alertStream.push(checkWallApproach(expiration, future, levels.callWall, levels.putWall));

    // Phase 7: Expected Move bands for the selected expiration (Hernán Q6.c — both EMs)
    const atmIvValue = atmIv(rows, future);
    const daysToExpiry = (rows[0].expirationTimestamp - Date.now()) / 86_400_000;
    const expectedMove = atmIvValue != null
      ? expectedMoveBands(future, atmIvValue, daysToExpiry)
      : null;

    res.json({
      currency,
      expiration,
      fetchedAt: Date.now(),
      future,
      count: rows.length,
      maxPain: mp?.strike ?? null,
      oi,
      ivCurve: iv,
      gex,
      gexCovered: gexRows.length,
      gammaFlip: levels.gammaFlip,
      callWall: levels.callWall,
      putWall: levels.putWall,
      regime: levels.regime,
      expectedMove,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/surface', async (req: Request, res: Response) => {
  try {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : 'BTC';
    const tenors = Math.max(2, Math.min(8, Number(req.query.tenors ?? 6)));

    const data = await fetchBookSummary(currency);
    const now = Date.now();
    const rows = data
      .map((row) => {
        const p = parseInstrument(row.instrument_name);
        if (!p || p.expirationTimestamp <= now) return null;
        return {
          ...p,
          markIv: row.mark_iv ?? 0,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const surface = buildSurface(rows, tenors);

    const termStructure = surface.rows.map((sr) => {
      const expRows = rows.filter((r) => r.expiration === sr.expiration);
      const sk = skew25d(expRows);
      return {
        expiration: sr.expiration,
        tenorDays: sr.tenorDays,
        skew25d: sk.skew25d,
        callIv: sk.callIv ?? null,
        putIv: sk.putIv ?? null,
      };
    });

    // Phase 5: structural-fear rule
    alertStream.push(checkStructuralFear(termStructure));

    res.json({
      currency,
      fetchedAt: Date.now(),
      strikes: surface.strikes,
      expirations: surface.rows.map((sr) => ({
        expiration: sr.expiration,
        timestamp: sr.expirationTimestamp,
        tenorDays: sr.tenorDays,
      })),
      iv: surface.rows.map((sr) => sr.iv),
      termStructure,
      headlineSkew: termStructure[0]?.skew25d ?? null,
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
    const data = await fetchBookSummary('BTC');
    const now = Date.now();
    // Group by expiration
    const byExp = new Map<string, typeof data>();
    for (const row of data) {
      const p = parseInstrument(row.instrument_name);
      if (!p || p.expirationTimestamp <= now) continue;
      const bucket = byExp.get(p.expiration) ?? [];
      bucket.push(row);
      byExp.set(p.expiration, bucket);
    }
    const ts = new Date();
    for (const [expiration, rows] of byExp) {
      const parsed = rows
        .map((row) => {
          const p = parseInstrument(row.instrument_name);
          return p
            ? {
                ...p,
                openInterest: row.open_interest,
                markIv: row.mark_iv ?? 0,
                underlyingPrice: row.underlying_price,
              }
            : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (!parsed.length) continue;
      const future = parsed[0].underlyingPrice;
      const oi = oiByStrike(parsed);
      const mp = maxPain(oi);
      const gexRows = parsed
        .map((r) => {
          const g = getGreeks(r.instrument);
          return g?.gamma != null && Number.isFinite(g.gamma)
            ? { strike: r.strike, type: r.type, openInterest: r.openInterest, gamma: g.gamma }
            : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      const gex = gexByStrike(gexRows, future);
      const levels = regimeReport(gex, future);
      const atm = atmIv(parsed, future);
      persistMetricSnapshot({
        ts,
        currency: 'BTC',
        expiration,
        future,
        maxPain: mp?.strike ?? null,
        gammaFlip: levels.gammaFlip,
        callWall: levels.callWall,
        putWall: levels.putWall,
        regime: levels.regime,
        oi,
        gex,
        atmIv: atm,
        count: parsed.length,
        gexCovered: gexRows.length,
      });
    }
  } catch (err) {
    console.error('[persist] metric snapshot batch failed', err);
  }
}

async function snapshotSurface(): Promise<void> {
  try {
    const data = await fetchBookSummary('BTC');
    const now = Date.now();
    const rows = data
      .map((row) => {
        const p = parseInstrument(row.instrument_name);
        if (!p || p.expirationTimestamp <= now) return null;
        return { ...p, markIv: row.mark_iv ?? 0 };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const surface = buildSurface(rows, 6);
    const termStructure = surface.rows.map((sr) => {
      const expRows = rows.filter((r) => r.expiration === sr.expiration);
      const sk = skew25d(expRows);
      return {
        expiration: sr.expiration,
        tenorDays: sr.tenorDays,
        skew25d: sk.skew25d,
        callIv: sk.callIv ?? null,
        putIv: sk.putIv ?? null,
      };
    });
    persistSurfaceSnapshot({
      ts: new Date(),
      currency: 'BTC',
      headlineSkew: termStructure[0]?.skew25d ?? null,
      termStructure,
    });
  } catch (err) {
    console.error('[persist] surface snapshot failed', err);
  }
}

async function pruneOldHistory(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  try {
    const [metrics, surface, trades, alerts, ticks, aggs] = await Promise.all([
      prisma.metricSnapshot.deleteMany({ where: { ts: { lt: cutoff } } }),
      prisma.surfaceSnapshot.deleteMany({ where: { ts: { lt: cutoff } } }),
      prisma.flowTrade.deleteMany({ where: { ts: { lt: cutoff } } }),
      prisma.alertLog.deleteMany({ where: { firstSeen: { lt: cutoff } } }),
      prisma.indexTick.deleteMany({ where: { ts: { lt: cutoff } } }),
      prisma.flowAggregateSnapshot.deleteMany({ where: { ts: { lt: cutoff } } }),
    ]);
    console.log(`[persist] pruned ${RETENTION_DAYS}d cutoff: metrics=${metrics.count} surface=${surface.count} trades=${trades.count} alerts=${alerts.count} ticks=${ticks.count} aggs=${aggs.count}`);
  } catch (err) {
    console.error('[persist] prune failed', err);
  }
}

function startPersistenceTimers(): void {
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

  // Prune retention — daily
  setInterval(pruneOldHistory, 24 * 60 * 60_000);
  setTimeout(pruneOldHistory, 60_000);

  console.log('[persist] timers started: indexTick=30s · metric/surface=5m · aggregate=60s · prune=24h');
}
