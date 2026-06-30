import type { FlowEvent } from '../compute/tradeFlow.js';

interface Bucket {
  signedNotional: number;
  deltaFlowUsd: number;
  deltaCount: number;
  vegaFlowUsd: number;
  vegaCount: number;
  buyCount: number;
  sellCount: number;
}

interface StoredBucket {
  signedNotional: number;
  deltaFlowUsd?: number;
  deltaCount?: number;
  vegaFlowUsd?: number;
  vegaCount?: number;
  buyCount: number;
  sellCount: number;
}

const BUCKET_MS = 60_000;
export const FLOW_BUCKET_MS = BUCKET_MS;
export type FlowBucketMode = 'clock_aligned';

const RETENTION_MS = 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;

/**
 * Sliding-window aggregator for NetFlow (Phase 8).
 * 1-min buckets × 1440 (= 24h), aligned to wall-clock minutes
 * (`minute = floor(ts / 60s) * 60s`). Window sums buckets with
 * `minute >= now - window` and `minute <= now` (inclusive borders;
 * current minute bucket is partial). Hernán Q2-B (2026-06-29).
 */
class FlowAggregator {
  private buckets = new Map<number, Bucket>();
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
  }

  add(event: FlowEvent): void {
    const minute = Math.floor(event.ts / BUCKET_MS) * BUCKET_MS;
    const bucket = this.buckets.get(minute) ?? {
      signedNotional: 0,
      deltaFlowUsd: 0,
      deltaCount: 0,
      vegaFlowUsd: 0,
      vegaCount: 0,
      buyCount: 0,
      sellCount: 0,
    };
    bucket.deltaFlowUsd ??= 0;
    bucket.deltaCount ??= 0;
    bucket.vegaFlowUsd ??= 0;
    bucket.vegaCount ??= 0;
    bucket.signedNotional += event.signedNotional;
    if (event.deltaFlowUsd != null && Number.isFinite(event.deltaFlowUsd)) {
      bucket.deltaFlowUsd += event.deltaFlowUsd;
      bucket.deltaCount += 1;
    }
    if (event.vegaFlowUsd != null && Number.isFinite(event.vegaFlowUsd)) {
      bucket.vegaFlowUsd += event.vegaFlowUsd;
      bucket.vegaCount += 1;
    }
    if (event.side === 'buy') bucket.buyCount += 1;
    else bucket.sellCount += 1;
    this.buckets.set(minute, bucket);
  }

  netForWindow(windowMinutes: number, nowMs = Date.now()): {
    signedNotional: number;
    deltaFlowUsd: number;
    deltaCount: number;
    vegaFlowUsd: number;
    vegaCount: number;
    buyCount: number;
    sellCount: number;
    bucketsUsed: number;
    windowMinutes: number;
  } {
    const cutoff = nowMs - windowMinutes * 60_000;
    let signedNotional = 0;
    let deltaFlowUsd = 0;
    let deltaCount = 0;
    let vegaFlowUsd = 0;
    let vegaCount = 0;
    let buyCount = 0;
    let sellCount = 0;
    let bucketsUsed = 0;
    for (const [minute, bucket] of this.buckets) {
      if (minute >= cutoff && minute <= nowMs) {
        signedNotional += bucket.signedNotional;
        deltaFlowUsd += bucket.deltaFlowUsd ?? 0;
        deltaCount += bucket.deltaCount ?? 0;
        vegaFlowUsd += bucket.vegaFlowUsd ?? 0;
        vegaCount += bucket.vegaCount ?? 0;
        buyCount += bucket.buyCount;
        sellCount += bucket.sellCount;
        bucketsUsed += 1;
      }
    }
    return {
      signedNotional,
      deltaFlowUsd,
      deltaCount,
      vegaFlowUsd,
      vegaCount,
      buyCount,
      sellCount,
      bucketsUsed,
      windowMinutes,
    };
  }

  seriesForWindow(windowMinutes: number, nowMs = Date.now()): Array<{
    ts: number;
    signedNotional: number;
    deltaFlowUsd: number;
    deltaCount: number;
    vegaFlowUsd: number;
    vegaCount: number;
    buyCount: number;
    sellCount: number;
  }> {
    const cutoff = nowMs - windowMinutes * 60_000;
    return [...this.buckets.entries()]
      .filter(([minute]) => minute >= cutoff && minute <= nowMs)
      .sort((a, b) => a[0] - b[0])
      .map(([minute, bucket]) => ({
        ts: minute,
        signedNotional: bucket.signedNotional,
        deltaFlowUsd: bucket.deltaFlowUsd ?? 0,
        deltaCount: bucket.deltaCount ?? 0,
        vegaFlowUsd: bucket.vegaFlowUsd ?? 0,
        vegaCount: bucket.vegaCount ?? 0,
        buyCount: bucket.buyCount,
        sellCount: bucket.sellCount,
      }));
  }

  prune(nowMs = Date.now()): void {
    const cutoff = nowMs - RETENTION_MS;
    for (const minute of this.buckets.keys()) {
      if (minute < cutoff) this.buckets.delete(minute);
    }
  }

  size(): number {
    return this.buckets.size;
  }

  /**
   * Phase 11: dump current buckets for persistence + restart-recovery.
   */
  snapshotBuckets(): Map<number, Bucket> {
    return new Map(this.buckets);
  }

  /**
   * Phase 11: restore buckets from snapshot (called once on startup).
   * Drops anything older than retention window.
   */
  restoreBuckets(snapshot: Record<string, StoredBucket>, nowMs = Date.now()): void {
    const cutoff = nowMs - RETENTION_MS;
    for (const [minuteStr, bucket] of Object.entries(snapshot)) {
      const minute = Number(minuteStr);
      if (!Number.isFinite(minute) || minute < cutoff) continue;
      this.buckets.set(minute, {
        signedNotional: bucket.signedNotional,
        deltaFlowUsd: bucket.deltaFlowUsd ?? 0,
        deltaCount: bucket.deltaCount ?? 0,
        vegaFlowUsd: bucket.vegaFlowUsd ?? 0,
        vegaCount: bucket.vegaCount ?? 0,
        buyCount: bucket.buyCount,
        sellCount: bucket.sellCount,
      });
    }
  }
}

export const flowAggregator = new FlowAggregator();

/** Window metadata for API reconciliation (Hernán Q2-B). */
export function flowWindowMeta(windowMinutes: number, nowMs = Date.now()): {
  windowStart: number;
  windowEnd: number;
  bucketMs: number;
  bucketMode: FlowBucketMode;
} {
  return {
    windowStart: nowMs - windowMinutes * 60_000,
    windowEnd: nowMs,
    bucketMs: FLOW_BUCKET_MS,
    bucketMode: 'clock_aligned',
  };
}
