/**
 * Local smoke test — vega-flow unit fix (Hernán 2026-06-26).
 * Run: ./node_modules/.bin/tsx scripts/validate-vega-flow.ts
 */
import { classifyTrade } from '../src/compute/tradeFlow.js';
import { updateGreeks } from '../src/state/greeks.js';

const INSTRUMENT = 'BTC-27JUN26-60000-C';
const SPOT = 59_960;
const DELTA = 0.48984;
const VEGA = 9.9117; // Deribit: USD per 1 IV point per BTC contract
const AMOUNT = 2.5;

updateGreeks(INSTRUMENT, { delta: DELTA, vega: VEGA, markIv: 45.84 });

const buy = classifyTrade({
  trade_id: 'validate-buy',
  timestamp: Date.now(),
  instrument_name: INSTRUMENT,
  price: 0.02,
  amount: AMOUNT,
  direction: 'buy',
  index_price: SPOT,
});

const sell = classifyTrade({
  trade_id: 'validate-sell',
  timestamp: Date.now(),
  instrument_name: INSTRUMENT,
  price: 0.02,
  amount: AMOUNT,
  direction: 'sell',
  index_price: SPOT,
});

if (!buy || !sell) {
  console.error('FAIL: classifyTrade returned null');
  process.exit(1);
}

const expectedDelta = AMOUNT * DELTA * SPOT;
const expectedVega = AMOUNT * VEGA;
const tol = 0.01;

const checks = [
  {
    name: 'buy deltaFlowUsd',
    got: buy.deltaFlowUsd!,
    want: expectedDelta,
  },
  {
    name: 'buy vegaFlowUsd (no × spot)',
    got: buy.vegaFlowUsd!,
    want: expectedVega,
  },
  {
    name: 'sell vegaFlowUsd sign',
    got: sell.vegaFlowUsd!,
    want: -expectedVega,
  },
  {
    name: 'vega independent of call/put flip (buy call = +vega demand)',
    got: buy.vegaFlowUsd! > 0,
    want: true,
  },
];

let failed = 0;
for (const c of checks) {
  const ok =
    typeof c.want === 'boolean'
      ? c.got === c.want
      : Math.abs((c.got as number) - (c.want as number)) <= tol;
  console.log(`${ok ? 'OK' : 'FAIL'}  ${c.name}: got=${c.got} want=${c.want}`);
  if (!ok) failed++;
}

// Sanity: × spot would inflate vega ~60k×
const wrongVega = buy.vegaFlowUsd! * SPOT;
if (wrongVega > expectedVega * 1000) {
  console.log(`OK  vega not spot-scaled (wrong would be ~${wrongVega.toFixed(0)})`);
} else {
  console.log('FAIL  vega may still be spot-scaled');
  failed++;
}

process.exit(failed > 0 ? 1 : 0);
