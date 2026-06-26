/**
 * Features V2 final validation smoke test.
 * Run: ./node_modules/.bin/tsx scripts/validate-features-v2.ts
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:4000';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

function ok(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'OK' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

async function main() {
  let failed = 0;
  const fail = (label: string, detail = '') => {
    ok(label, false, detail);
    failed++;
  };

  const live = await get<{ ok: boolean }>('/api/live');
  if (!ok('live', live.ok)) failed++;

  const exp = await get<{ expirations: Array<{ expiration: string }> }>('/api/expirations?currency=BTC');
  const front = exp.expirations[0]?.expiration;
  if (!front) fail('expirations', 'no expirations');
  else ok('expirations', true, front);

  const totals = await get<{
    oiCpRatio: number | null;
    gexCpRatio: number | null;
    callsOi: number;
    putsOi: number;
  }>('/api/totals?currency=BTC');
  if (!ok('totals C/P ratios', totals.callsOi > 0 && totals.putsOi > 0, `oi=${totals.oiCpRatio?.toFixed(2)} gex=${totals.gexCpRatio?.toFixed(2)}`)) failed++;

  if (front) {
    const metrics = await get<{
      volume: unknown[];
      volOi: unknown[];
      keyStrikes: { topByGex: unknown[]; topByOi: unknown[]; topByVol: unknown[] };
      ivCurve: Array<{ strike: number; iv: number }>;
      dexSummary: { netDex: number };
      vexSummary: { netVex: number };
    }>(`/api/metrics?expiration=${front}&currency=BTC&scope=market`);
    if (!ok('metrics volume/volOi/keyStrikes', metrics.volume.length >= 0 && metrics.keyStrikes.topByGex.length > 0, `vol=${metrics.volume.length} gex=${metrics.keyStrikes.topByGex.length}`)) failed++;
    if (!ok('metrics ivCurve per expiry', metrics.ivCurve.length > 0, `${metrics.ivCurve.length} points`)) failed++;
    if (!ok('metrics DEX/VEX', Number.isFinite(metrics.dexSummary.netDex) && Number.isFinite(metrics.vexSummary.netVex))) failed++;
  }

  const flow = await get<{ vegaFlowUsd: number; deltaFlowUsd: number }>('/api/flow/net?window=1h');
  if (!ok('flow net', Number.isFinite(flow.deltaFlowUsd))) failed++;

  const emTable = await get<{ rows: unknown[] }>('/api/expected-move/table?currency=BTC');
  if (!ok('expected move table', emTable.rows.length > 0, `${emTable.rows.length} rows`)) failed++;

  const surface = await get<{ atmTermStructure: unknown[] }>('/api/surface?tenors=8&currency=BTC&axis=strike');
  if (!ok('ATM term structure', surface.atmTermStructure.length > 0, `${surface.atmTermStructure.length} points`)) failed++;

  const rank = await get<{ percentile: number | null; samplePoints: number }>('/api/dvol/rank?currency=BTC');
  ok('dvol rank', true, rank.percentile != null ? `${rank.percentile.toFixed(0)}th pct (${rank.samplePoints} pts)` : `warming (${rank.samplePoints} pts)`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
