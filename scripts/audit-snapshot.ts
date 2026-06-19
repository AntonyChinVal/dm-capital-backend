/**
 * Offline regression against Hernán control numbers (feedback 18-Jun-2026).
 * Usage: pnpm audit:snapshot [path-to-deribit_data.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BookSummary, DeribitEnvelope } from '../src/types.js';
import {
  computeMetricsBundle,
  parseBookRows,
  buildSkewTermStructure,
} from '../src/compute/metricsBundle.js';
import { pickHeadlineSkew } from '../src/compute/interpret/skewTiles.js';
import { filterLiquidStrikes } from '../src/compute/liquidStrikes.js';
import { filterCurveStrikes } from '../src/compute/curveFilter.js';

const SNAPSHOT_AT = Date.parse('2026-06-18T21:06:00Z');
const SPOT = 63_026;

const DEFAULT_JSON = resolve(
  import.meta.dirname,
  '../../docs/feedback_18_6_26/deribit_data.json',
);

interface Control {
  label: string;
  expected: number;
  tolerance: number;
  actual: number | null;
}

function roundK(n: number | null): number | null {
  if (n == null) return null;
  return Math.round(n / 1000) * 1000;
}

function loadBook(path: string): BookSummary[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as DeribitEnvelope<BookSummary[]>;
  if (!raw.result?.length) throw new Error(`No result array in ${path}`);
  return raw.result;
}

function pickSkew7d(allRows: ReturnType<typeof parseBookRows>): number | null {
  const term = buildSkewTermStructure(allRows, 8, SNAPSHOT_AT);
  return pickHeadlineSkew(term);
}

function checkMax(
  label: string,
  actual: number | null,
  maxAllowed: number,
  suffix = '',
): Control {
  const pass = actual != null && actual <= maxAllowed;
  const status = pass ? 'PASS' : 'FAIL';
  const fmt = (n: number | null) => (n != null ? n.toLocaleString() + suffix : '—');
  console.log(
    `${status}  ${label.padEnd(28)} max ${maxAllowed.toLocaleString()}${suffix}  got ${fmt(actual)}`,
  );
  return { label, expected: maxAllowed, tolerance: 0, actual: pass ? actual : -1 };
}

function check(
  label: string,
  expected: number,
  actual: number | null,
  tolerance = 1500,
  roundThousands = true,
): Control {
  const a = roundThousands ? roundK(actual) : actual;
  const pass = a != null && Math.abs(a - expected) <= tolerance;
  const status = pass ? 'PASS' : 'FAIL';
  const fmt = (n: number | null) =>
    n != null ? (roundThousands ? '$' + n.toLocaleString() : n.toFixed(1) + '%') : '—';
  console.log(
    `${status}  ${label.padEnd(28)} expected ${
      roundThousands ? '$' + expected.toLocaleString() : expected + '%'
    }  got ${fmt(a)}`,
  );
  return { label, expected, tolerance, actual: a };
}

function main() {
  const jsonPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_JSON;
  console.log(`\nAudit snapshot: ${jsonPath}`);
  console.log(`As-of: ${new Date(SNAPSHOT_AT).toISOString()}  spot: $${SPOT.toLocaleString()}\n`);

  const data = loadBook(jsonPath);
  const allRows = parseBookRows(data, SNAPSHOT_AT);
  console.log(`Instruments parsed: ${allRows.length}\n`);

  const expirations = [...new Set(allRows.map((r) => r.expiration))].sort();
  const exp19 = expirations.find((e) => e.includes('19JUN26'));
  const exp26 = expirations.find((e) => e.includes('26JUN26'));
  if (!exp19 || !exp26) {
    console.error('Could not find 19JUN26 / 26JUN26 in snapshot:', expirations.slice(0, 10));
    process.exit(1);
  }

  const market = computeMetricsBundle(allRows, exp19, 'market', SPOT, SNAPSHOT_AT);
  const local19 = computeMetricsBundle(allRows, exp19, 'expiration', SPOT, SNAPSHOT_AT);
  const local26 = computeMetricsBundle(allRows, exp26, 'expiration', SPOT, SNAPSHOT_AT);
  const skew7d = pickSkew7d(allRows);

  if (!market || !local19 || !local26) {
    console.error('computeMetricsBundle returned null');
    process.exit(1);
  }

  const results: Control[] = [
    check('Market γ-flip', 64_699, market.macro.gammaFlip),
    check('Flip 26JUN (expiry)', 67_294, local26.gammaFlip),
    check('Structural call wall', 80_000, market.macro.callWall),
    check('Structural put wall', 62_000, market.macro.putWall),
    check('Local resistance 19JUN', 64_000, local19.local.resistance),
    check('Local support 19JUN', 63_000, local19.local.support),
    check('Local resistance 26JUN', 67_000, local26.local.resistance),
    check('Local support 26JUN', 60_000, local26.local.support),
    check('Max pain 19JUN', 65_000, local19.maxPain),
    check('Max pain 26JUN', 74_000, local26.maxPain),
    check('Skew 7D tile', 10.2, skew7d, 1.5, false),
  ];

  const local26Iv = local26.ivCurve;
  const maxStrike26 = local26Iv.length ? Math.max(...local26Iv.map((p) => p.strike)) : null;
  const maxIv26 = local26Iv.length ? Math.max(...local26Iv.map((p) => p.iv)) : null;
  const garbageBefore = filterLiquidStrikes(allRows.filter((r) => r.expiration.includes('26JUN26')))
    .filter((r) => r.markIv >= 125 && (r.volume ?? 0) === 0).length;
  const garbageAfter = filterCurveStrikes(
    filterLiquidStrikes(allRows.filter((r) => r.expiration.includes('26JUN26'))),
    { now: SNAPSHOT_AT },
  ).filter((r) => r.markIv >= 125).length;

  console.log('\nSmirk filter (26JUN):');
  results.push(checkMax('Max strike in IV curve', maxStrike26, 100_000));
  results.push(checkMax('Max IV in curve (< cap)', maxIv26, 124, '%'));
  console.log(
    `INFO  Garbage wings 26JUN (IV≥125, vol=0): ${garbageBefore} before → ${garbageAfter} after curve filter`,
  );

  const failed = results.filter((r) => {
    if (r.actual == null) return true;
    if (r.tolerance === 0) return r.actual < 0;
    return Math.abs(r.actual - r.expected) > r.tolerance;
  });

  console.log(`\n${failed.length === 0 ? 'All checks passed.' : `${failed.length} check(s) failed.`}\n`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
