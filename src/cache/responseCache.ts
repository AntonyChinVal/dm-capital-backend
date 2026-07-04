const DEFAULT_RESPONSE_CACHE_TTL_MS = 8_000;

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

const RESPONSE_CACHE_TTL_MS = envNumber(
  'API_RESPONSE_CACHE_TTL_MS',
  DEFAULT_RESPONSE_CACHE_TTL_MS,
  0,
);

interface ResponseCacheEntry<T> {
  value?: T;
  expiresAt: number;
  inFlight?: Promise<T>;
}

const responseCache = new Map<string, ResponseCacheEntry<unknown>>();

export async function cachedResponse<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs = RESPONSE_CACHE_TTL_MS,
): Promise<T> {
  if (ttlMs === 0) {
    return compute();
  }

  const now = Date.now();
  const cached = responseCache.get(key) as ResponseCacheEntry<T> | undefined;
  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const request = compute()
    .then((value) => {
      responseCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
      return value;
    })
    .finally(() => {
      const entry = responseCache.get(key);
      if (entry?.inFlight === request) {
        responseCache.set(key, { ...entry, inFlight: undefined });
      }
    });

  responseCache.set(key, {
    value: cached?.value,
    expiresAt: cached?.expiresAt ?? 0,
    inFlight: request,
  });

  return request;
}

export function getResponseCacheStatus() {
  const now = Date.now();
  return {
    ttlMs: RESPONSE_CACHE_TTL_MS,
    entries: responseCache.size,
    keys: [...responseCache.keys()].slice(0, 20),
    sample: [...responseCache.entries()].slice(0, 8).map(([key, entry]) => ({
      key,
      expiresInMs: Math.max(0, entry.expiresAt - now),
      inFlight: Boolean(entry.inFlight),
    })),
  };
}
