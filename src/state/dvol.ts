export interface DvolSnapshot {
  value: number;
  ts: number;
}

const store = new Map<string, DvolSnapshot>();

export function updateDvol(indexName: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  store.set(indexName, { value, ts: Date.now() });
}

export function getDvol(indexName = 'btc_usd'): DvolSnapshot | null {
  return store.get(indexName) ?? null;
}
