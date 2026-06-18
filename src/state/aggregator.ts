import type { FlowEvent } from '../compute/tradeFlow.js';

interface Bucket {
  signedNotional: number;
  buyCount: number;
  sellCount: number;
}

const BUCKET_MS = 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 60_000;

/**
 * Sliding-window aggregator for NetFlow (Phase 8).
 * 1-min buckets × 1440 (= 24h). Per-bucket sums of `signedNotional` from
 * the directional-sentiment convention (Hernán Q8). On restart, current
 * implementation loses 24h of buckets — backed by Prisma in Phase 11
 * (see B8.3).
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
      buyCount: 0,
      sellCount: 0,
    };
    bucket.signedNotional += event.signedNotional;
    if (event.side === 'buy') bucket.buyCount += 1;
    else bucket.sellCount += 1;
    this.buckets.set(minute, bucket);
  }

  netForWindow(windowMinutes: number, nowMs = Date.now()): {
    signedNotional: number;
    buyCount: number;
    sellCount: number;
    bucketsUsed: number;
    windowMinutes: number;
  } {
    const cutoff = nowMs - windowMinutes * 60_000;
    let signedNotional = 0;
    let buyCount = 0;
    let sellCount = 0;
    let bucketsUsed = 0;
    for (const [minute, bucket] of this.buckets) {
      if (minute >= cutoff && minute <= nowMs) {
        signedNotional += bucket.signedNotional;
        buyCount += bucket.buyCount;
        sellCount += bucket.sellCount;
        bucketsUsed += 1;
      }
    }
    return {
      signedNotional,
      buyCount,
      sellCount,
      bucketsUsed,
      windowMinutes,
    };
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
  restoreBuckets(snapshot: Record<string, Bucket>, nowMs = Date.now()): void {
    const cutoff = nowMs - RETENTION_MS;
    for (const [minuteStr, bucket] of Object.entries(snapshot)) {
      const minute = Number(minuteStr);
      if (!Number.isFinite(minute) || minute < cutoff) continue;
      this.buckets.set(minute, bucket);
    }
  }
}

export const flowAggregator = new FlowAggregator();
