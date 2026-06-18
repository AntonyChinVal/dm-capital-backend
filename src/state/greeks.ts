export interface GreeksRow {
  instrument: string;
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
  markIv?: number;
  markPrice?: number;
  underlyingPrice?: number;
  openInterest?: number;
  lastUpdate: number;
}

const store = new Map<string, GreeksRow>();

export function updateGreeks(instrument: string, patch: Partial<Omit<GreeksRow, 'instrument' | 'lastUpdate'>>): void {
  const prev = store.get(instrument);
  const merged: GreeksRow = {
    instrument,
    ...(prev ?? {}),
    ...patch,
    lastUpdate: Date.now(),
  };
  store.set(instrument, merged);
}

export function getGreeks(instrument: string): GreeksRow | undefined {
  return store.get(instrument);
}

export function greeksCount(): number {
  return store.size;
}

export function greeksWithGamma(): number {
  let n = 0;
  for (const row of store.values()) {
    if (row.gamma != null && Number.isFinite(row.gamma)) n++;
  }
  return n;
}
