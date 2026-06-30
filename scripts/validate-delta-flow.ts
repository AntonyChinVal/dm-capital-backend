/**
 * Bucket window reconciliation helper (Hernán Q2-B, feedback 29-Jun-2026).
 * Run: cd backend && pnpm exec tsx scripts/validate-delta-flow.ts
 */
import { flowAggregator, flowWindowMeta, FLOW_BUCKET_MS } from '../src/state/aggregator.js';
import type { FlowEvent } from '../src/compute/tradeFlow.js';

function trade(ts: number, deltaFlowUsd: number): FlowEvent {
  return {
    id: `t-${ts}`,
    ts,
    instrument: 'BTC-27JUN26-60000-C',
    strike: 60_000,
    expiration: '27JUN26',
    type: 'C',
    side: 'buy',
    tag: 'sweep',
    amount: 1,
    notionalUsd: 1000,
    signedNotional: 1000,
    delta: 0.5,
    deltaFlowUsd,
    vega: null,
    vegaFlowUsd: null,
  };
}

const nowMs = Date.UTC(2026, 5, 29, 12, 30, 45_000);
const meta = flowWindowMeta(60, nowMs);

const insideTs = nowMs - 30 * 60_000;
const outsideTs = nowMs - 61 * 60_000;

flowAggregator.add(trade(insideTs, 1000));
flowAggregator.add(trade(outsideTs, 9999));

const result = flowAggregator.netForWindow(60, nowMs);

const checks = [
  {
    name: 'bucketMode clock_aligned',
    ok: meta.bucketMode === 'clock_aligned',
    got: meta.bucketMode,
    want: 'clock_aligned',
  },
  {
    name: 'bucketMs 60s',
    ok: meta.bucketMs === FLOW_BUCKET_MS && meta.bucketMs === 60_000,
    got: meta.bucketMs,
    want: 60_000,
  },
  {
    name: 'windowStart = now - 60m',
    ok: meta.windowStart === nowMs - 60 * 60_000,
    got: meta.windowStart,
    want: nowMs - 60 * 60_000,
  },
  {
    name: 'inside trade counted',
    ok: result.deltaFlowUsd === 1000,
    got: result.deltaFlowUsd,
    want: 1000,
  },
  {
    name: 'outside trade excluded',
    ok: result.deltaCount === 1,
    got: result.deltaCount,
    want: 1,
  },
  {
    name: 'bucket alignment floor(ts/60s)*60s',
    ok: Math.floor(insideTs / FLOW_BUCKET_MS) * FLOW_BUCKET_MS >= meta.windowStart,
    got: Math.floor(insideTs / FLOW_BUCKET_MS) * FLOW_BUCKET_MS,
    want: `>= ${meta.windowStart}`,
  },
];

let failed = 0;
console.log('\nDelta-flow window validation (Q2-B)\n');
console.log(JSON.stringify(meta, null, 2));
console.log('');
for (const c of checks) {
  console.log(`${c.ok ? 'OK' : 'FAIL'}  ${c.name}: got=${c.got} want=${c.want}`);
  if (!c.ok) failed++;
}
console.log(failed === 0 ? '\nAll checks passed.\n' : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
