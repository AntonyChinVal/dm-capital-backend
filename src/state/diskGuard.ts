/** Pause local SQLite mirror writes when /data is nearly full. Neon outbox unchanged. */

const DEFAULT_MIRROR_DISABLE_PCT = Number(process.env.DISK_MIRROR_DISABLE_PCT ?? 85);

let mirrorWritesEnabled = true;
let lastUsedPercent: number | null = null;
let lastUpdatedAt: number | null = null;

export function updateDiskGuard(usedPercent: number, threshold = DEFAULT_MIRROR_DISABLE_PCT): void {
  const wasEnabled = mirrorWritesEnabled;
  lastUsedPercent = usedPercent;
  lastUpdatedAt = Date.now();
  mirrorWritesEnabled = usedPercent < threshold;

  if (wasEnabled && !mirrorWritesEnabled) {
    console.warn('[ops-alert]', JSON.stringify({
      ts: Date.now(),
      alerts: [{
        code: 'local_mirror_paused',
        severity: 'warning',
        message: `/data at ${usedPercent}% — local mirror writes paused (threshold ${threshold}%)`,
      }],
    }));
  } else if (!wasEnabled && mirrorWritesEnabled) {
    console.log(`[disk-guard] local mirror writes resumed at ${usedPercent}% disk usage`);
  }
}

export function isLocalMirrorEnabled(): boolean {
  return mirrorWritesEnabled;
}

export function getDiskGuardStatus() {
  return {
    mirrorWritesEnabled,
    lastUsedPercent,
    mirrorDisableThresholdPct: DEFAULT_MIRROR_DISABLE_PCT,
    lastUpdatedAt,
  };
}
