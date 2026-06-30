import { copyFile, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localPrisma } from '../db/local.js';

export interface DiskUsageSnapshot {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  status: 'ok' | 'warning' | 'critical' | 'unknown';
}

interface MaintenanceState {
  lastVacuumAt: number | null;
}

const STATE_FILENAME = '.sqlite-maintenance-state.json';
const BACKUP_PREFIX = 'dm-capital.db.backup-';

function envEnabled(name: string, defaultOn = true): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultOn;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function envHours(name: string, defaultHours: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : defaultHours;
}

function envPct(name: string, defaultPct: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : defaultPct;
}

/** Resolve absolute SQLite file path (matches local Prisma client). */
export function resolveSqliteDbPath(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw?.startsWith('file:')) return null;
  const rel = raw.slice('file:'.length);
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(process.cwd(), 'prisma', rel);
}

function statePath(dataDir: string): string {
  return path.join(dataDir, STATE_FILENAME);
}

async function readState(dataDir: string): Promise<MaintenanceState> {
  try {
    const raw = await readFile(statePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as MaintenanceState;
    return {
      lastVacuumAt:
        typeof parsed.lastVacuumAt === 'number' && Number.isFinite(parsed.lastVacuumAt)
          ? parsed.lastVacuumAt
          : null,
    };
  } catch {
    return { lastVacuumAt: null };
  }
}

async function writeState(dataDir: string, state: MaintenanceState): Promise<void> {
  await writeFile(statePath(dataDir), JSON.stringify(state, null, 2), 'utf8');
}

function backupTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export async function runSqliteCheckpoint(): Promise<{ busy: number; log: number; checkpointed: number }> {
  const rows = await localPrisma.$queryRawUnsafe<
    Array<{ busy: number; log: number; checkpointed: number }>
  >('PRAGMA wal_checkpoint(TRUNCATE)');
  const row = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };
  return {
    busy: Number(row.busy),
    log: Number(row.log),
    checkpointed: Number(row.checkpointed),
  };
}

export async function runSqliteVacuum(): Promise<void> {
  await localPrisma.$executeRawUnsafe('VACUUM');
}

export async function createSqliteBackup(dataDir: string): Promise<string | null> {
  const dbPath = resolveSqliteDbPath();
  if (!dbPath) {
    console.warn('[sqlite-maintenance] skip backup — DATABASE_URL is not a file: URL');
    return null;
  }
  const dest = path.join(dataDir, `${BACKUP_PREFIX}${backupTimestamp()}`);
  await copyFile(dbPath, dest);
  return dest;
}

export async function pruneSqliteBackups(dataDir: string): Promise<number> {
  const ttlHours = envHours('SQLITE_BACKUP_TTL_HOURS', 48);
  const cutoff = Date.now() - ttlHours * 60 * 60_000;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(BACKUP_PREFIX)) continue;
    const full = path.join(dataDir, name);
    try {
      const st = await stat(full);
      if (st.mtimeMs < cutoff) {
        await unlink(full);
        removed += 1;
      }
    } catch (err) {
      console.warn(`[sqlite-maintenance] failed to prune backup ${name}`, err);
    }
  }
  return removed;
}

function shouldRunVacuum(dataDisk: DiskUsageSnapshot, lastVacuumAt: number | null): boolean {
  const thresholdPct = envPct('SQLITE_VACUUM_DISK_THRESHOLD_PCT', 70);
  const minIntervalHours = envHours('SQLITE_VACUUM_MIN_INTERVAL_HOURS', 168);
  const minIntervalMs = minIntervalHours * 60 * 60_000;

  if (dataDisk.status === 'warning' || dataDisk.status === 'critical') {
    return true;
  }
  if (dataDisk.usedPercent >= thresholdPct) {
    return true;
  }
  if (lastVacuumAt == null) {
    return false;
  }
  return Date.now() - lastVacuumAt >= minIntervalMs;
}

async function fileSizeBytes(filePath: string): Promise<number> {
  try {
    const st = await stat(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

/**
 * Daily SQLite maintenance: checkpoint always; vacuum only when disk pressure or
 * weekly interval; backups TTL-pruned automatically.
 */
export async function runSqliteMaintenanceIfNeeded(dataDisk: DiskUsageSnapshot): Promise<void> {
  if (!envEnabled('SQLITE_MAINTENANCE_ENABLED', true)) {
    return;
  }

  const dataDir = dataDisk.path;
  const dbPath = resolveSqliteDbPath();

  try {
    const checkpoint = await runSqliteCheckpoint();
    console.log(
      `[sqlite-maintenance] checkpoint busy=${checkpoint.busy} log=${checkpoint.log} checkpointed=${checkpoint.checkpointed}`,
    );

    const prunedBefore = await pruneSqliteBackups(dataDir);
    if (prunedBefore > 0) {
      console.log(`[sqlite-maintenance] pruned ${prunedBefore} backup(s) older than TTL`);
    }

    const state = await readState(dataDir);
    if (!shouldRunVacuum(dataDisk, state.lastVacuumAt)) {
      console.log(
        `[sqlite-maintenance] vacuum skipped disk=${dataDisk.usedPercent}% lastVacuum=${state.lastVacuumAt ?? 'never'}`,
      );
      return;
    }

    if (!dbPath) {
      console.warn('[sqlite-maintenance] vacuum skipped — no SQLite file path');
      return;
    }

    const dbBytes = await fileSizeBytes(dbPath);
    const requiredFree = Math.ceil(dbBytes * 1.15);
    if (dataDisk.freeBytes < requiredFree) {
      console.warn(
        `[sqlite-maintenance] vacuum skipped — need ~${requiredFree} bytes free, have ${dataDisk.freeBytes}`,
      );
      return;
    }

    const beforeBytes = dbBytes;
    const backupPath = await createSqliteBackup(dataDir);
    console.log(`[sqlite-maintenance] backup created: ${backupPath ?? 'skipped'}`);

    await runSqliteVacuum();
    const afterBytes = await fileSizeBytes(dbPath);
    await writeState(dataDir, { lastVacuumAt: Date.now() });

    const prunedAfter = await pruneSqliteBackups(dataDir);
    console.log(
      `[sqlite-maintenance] vacuum done db ${beforeBytes} → ${afterBytes} bytes · pruned ${prunedAfter} backup(s)`,
    );
  } catch (err) {
    console.error('[sqlite-maintenance] failed', err);
  }
}
