import type { BookSummary, DeribitEnvelope, IndexPrice } from '../types.js';

const DERIBIT_REST = process.env.DERIBIT_REST ?? 'https://www.deribit.com/api/v2';

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

export function fetchBookSummary(currency = 'BTC'): Promise<BookSummary[]> {
  return call<BookSummary[]>('public/get_book_summary_by_currency', {
    currency,
    kind: 'option',
  });
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
