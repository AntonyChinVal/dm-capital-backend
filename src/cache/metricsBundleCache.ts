import { computeMetricsBundle, type MetricsBundle, type MetricsScope, type ParsedOptionRow } from '../compute/metricsBundle.js';
import { getBookSummaryFetchedAt } from '../deribit/rest.js';

interface BundleCacheEntry {
  bookFetchedAt: number;
  bundle: MetricsBundle;
}

const bundleCache = new Map<string, BundleCacheEntry>();

function cacheKey(currency: string, expiration: string, scope: MetricsScope): string {
  return `${currency}:${expiration}:${scope}`;
}

export function computeMetricsBundleCached(
  currency: string,
  allRows: ParsedOptionRow[],
  expiration: string,
  scope: MetricsScope,
  spot: number,
  now = Date.now(),
  opts?: Parameters<typeof computeMetricsBundle>[5],
): MetricsBundle | null {
  const bookFetchedAt = getBookSummaryFetchedAt(currency) ?? now;
  const key = cacheKey(currency, expiration, scope);
  const hit = bundleCache.get(key);
  if (hit && hit.bookFetchedAt === bookFetchedAt) {
    return hit.bundle;
  }

  const bundle = computeMetricsBundle(allRows, expiration, scope, spot, now, opts);
  if (bundle) {
    bundleCache.set(key, { bookFetchedAt, bundle });
  }
  return bundle;
}

export function clearMetricsBundleCache(): void {
  bundleCache.clear();
}
