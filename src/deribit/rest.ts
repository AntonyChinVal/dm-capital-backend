import type { BookSummary, DeribitEnvelope, IndexPrice } from '../types.js';

const DERIBIT_REST = process.env.DERIBIT_REST ?? 'https://www.deribit.com/api/v2';
const DEFAULT_BOOK_SUMMARY_CACHE_TTL_MS = 15_000;
const DEFAULT_BOOK_SUMMARY_STALE_MAX_MS = 120_000;
const DEFAULT_BOOK_SUMMARY_STALE_IF_ERROR_MS = 60_000;
const DEFAULT_BOOK_SUMMARY_CACHE_MAX_ENTRIES = 8;
const DEFAULT_BOOK_SUMMARY_WARM_INTERVAL_MS = 8_000;

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

const BOOK_SUMMARY_CACHE_TTL_MS = envNumber(
  'DERIBIT_BOOK_SUMMARY_CACHE_TTL_MS',
  DEFAULT_BOOK_SUMMARY_CACHE_TTL_MS,
  0,
);
const BOOK_SUMMARY_STALE_MAX_MS = envNumber(
  'DERIBIT_BOOK_SUMMARY_STALE_MAX_MS',
  DEFAULT_BOOK_SUMMARY_STALE_MAX_MS,
  0,
);
const BOOK_SUMMARY_STALE_IF_ERROR_MS = envNumber(
  'DERIBIT_BOOK_SUMMARY_STALE_IF_ERROR_MS',
  DEFAULT_BOOK_SUMMARY_STALE_IF_ERROR_MS,
  0,
);
const BOOK_SUMMARY_CACHE_MAX_ENTRIES = Math.trunc(
  envNumber('DERIBIT_BOOK_SUMMARY_CACHE_MAX_ENTRIES', DEFAULT_BOOK_SUMMARY_CACHE_MAX_ENTRIES, 1),
);
const BOOK_SUMMARY_WARM_INTERVAL_MS = envNumber(
  'DERIBIT_BOOK_SUMMARY_WARM_INTERVAL_MS',
  DEFAULT_BOOK_SUMMARY_WARM_INTERVAL_MS,
  1_000,
);

interface BookSummaryCacheEntry {
  value?: BookSummary[];
  fetchedAt: number | null;
  expiresAt: number;
  inFlight?: Promise<BookSummary[]>;
}

const bookSummaryCache = new Map<string, BookSummaryCacheEntry>();
let bookSummaryWarmerStarted = false;

function ensureBookSummaryCacheCapacity(currency: string): void {
  if (bookSummaryCache.has(currency) || bookSummaryCache.size < BOOK_SUMMARY_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestCurrency = [...bookSummaryCache.entries()]
    .sort(([, a], [, b]) => (a.fetchedAt ?? 0) - (b.fetchedAt ?? 0))[0]?.[0];
  if (oldestCurrency) {
    bookSummaryCache.delete(oldestCurrency);
  }
}

async function call<T>(method: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${DERIBIT_REST}/${method}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Deribit ${method} HTTP ${res.status}`);
  }

  const envelope = (await res.json()) as DeribitEnvelope<T>;
  if (envelope.error) {
    throw new Error(`Deribit ${method}: ${envelope.error.message} (code ${envelope.error.code})`);
  }
  if (envelope.result === undefined) {
    throw new Error(`Deribit ${method}: empty result`);
  }
  return envelope.result;
}

function storeBookSummaryCache(
  normalizedCurrency: string,
  value: BookSummary[],
  prior?: BookSummaryCacheEntry,
): void {
  const fetchedAt = Date.now();
  ensureBookSummaryCacheCapacity(normalizedCurrency);
  bookSummaryCache.set(normalizedCurrency, {
    value,
    fetchedAt,
    expiresAt: fetchedAt + BOOK_SUMMARY_CACHE_TTL_MS,
    inFlight: prior?.inFlight,
  });
}

function refreshBookSummaryInBackground(normalizedCurrency: string): void {
  void refreshBookSummary(normalizedCurrency);
}

function refreshBookSummary(normalizedCurrency: string): Promise<BookSummary[]> {
  const cached = bookSummaryCache.get(normalizedCurrency);
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const request = call<BookSummary[]>('public/get_book_summary_by_currency', {
    currency: normalizedCurrency,
    kind: 'option',
  })
    .then((value) => {
      storeBookSummaryCache(normalizedCurrency, value);
      return value;
    })
    .catch((err) => {
      if (
        cached?.value &&
        cached.fetchedAt != null &&
        Date.now() - cached.fetchedAt <= BOOK_SUMMARY_STALE_IF_ERROR_MS
      ) {
        return cached.value;
      }
      throw err;
    })
    .finally(() => {
      const entry = bookSummaryCache.get(normalizedCurrency);
      if (entry?.inFlight === request) {
        bookSummaryCache.set(normalizedCurrency, { ...entry, inFlight: undefined });
      }
    });

  ensureBookSummaryCacheCapacity(normalizedCurrency);
  bookSummaryCache.set(normalizedCurrency, {
    value: cached?.value,
    fetchedAt: cached?.fetchedAt ?? null,
    expiresAt: cached?.expiresAt ?? 0,
    inFlight: request,
  });

  return request;
}

export function fetchBookSummary(currency = 'BTC'): Promise<BookSummary[]> {
  const normalizedCurrency = currency.toUpperCase();
  if (BOOK_SUMMARY_CACHE_TTL_MS === 0) {
    return call<BookSummary[]>('public/get_book_summary_by_currency', {
      currency: normalizedCurrency,
      kind: 'option',
    });
  }

  const now = Date.now();
  const cached = bookSummaryCache.get(normalizedCurrency);

  if (cached?.value && cached.expiresAt > now) {
    return Promise.resolve(cached.value);
  }

  // Stale-while-revalidate: never block live reads on Deribit when we have recent data.
  if (
    cached?.value &&
    cached.fetchedAt != null &&
    now - cached.fetchedAt <= BOOK_SUMMARY_STALE_MAX_MS
  ) {
    refreshBookSummaryInBackground(normalizedCurrency);
    return Promise.resolve(cached.value);
  }

  return refreshBookSummary(normalizedCurrency);
}

export function startBookSummaryWarmer(currencies: string[] = ['BTC']): void {
  if (bookSummaryWarmerStarted || BOOK_SUMMARY_CACHE_TTL_MS === 0) {
    return;
  }
  bookSummaryWarmerStarted = true;

  const warm = () => {
    for (const currency of currencies) {
      const normalizedCurrency = currency.toUpperCase();
      const entry = bookSummaryCache.get(normalizedCurrency);
      const now = Date.now();
      if (entry?.inFlight) continue;
      if (!entry?.value || entry.expiresAt <= now) {
        refreshBookSummaryInBackground(normalizedCurrency);
      }
    }
  };

  warm();
  setInterval(warm, BOOK_SUMMARY_WARM_INTERVAL_MS);
}

export function getBookSummaryCacheStatus() {
  const now = Date.now();
  return {
    ttlMs: BOOK_SUMMARY_CACHE_TTL_MS,
    staleMaxMs: BOOK_SUMMARY_STALE_MAX_MS,
    staleIfErrorMs: BOOK_SUMMARY_STALE_IF_ERROR_MS,
    warmIntervalMs: BOOK_SUMMARY_WARM_INTERVAL_MS,
    maxEntries: BOOK_SUMMARY_CACHE_MAX_ENTRIES,
    entries: [...bookSummaryCache.entries()].map(([currency, entry]) => ({
      currency,
      rows: entry.value?.length ?? 0,
      fetchedAt: entry.fetchedAt,
      ageMs: entry.fetchedAt == null ? null : now - entry.fetchedAt,
      expiresInMs: Math.max(0, entry.expiresAt - now),
      stale: Boolean(entry.value && entry.expiresAt <= now),
      inFlight: Boolean(entry.inFlight),
    })),
  };
}

export function fetchIndexPrice(indexName = 'btc_usd'): Promise<IndexPrice> {
  return call<IndexPrice>('public/get_index_price', { index_name: indexName });
}

interface VolatilityIndexData {
  data: Array<[number, number, number, number, number]>; // [ts, open, high, low, close]
  continuation: string | null;
}

/**
 * Fetch the latest DVOL candle (close of the last 1-min window).
 * Used for initial bootstrap before the WS push arrives.
 */
export async function fetchDvolLatest(currency = 'BTC'): Promise<number | null> {
  const now = Date.now();
  const start = now - 5 * 60_000; // last 5 minutes window
  const result = await call<VolatilityIndexData>('public/get_volatility_index_data', {
    currency,
    start_timestamp: start,
    end_timestamp: now,
    resolution: 60,
  });
  if (!result.data?.length) return null;
  const last = result.data[result.data.length - 1];
  return last?.[4] ?? null; // close
}
