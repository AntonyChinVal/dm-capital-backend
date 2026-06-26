import path from 'node:path';
import { PrismaClient } from '../generated/local-client/index.js';

/**
 * Resolve the SQLite URL to the same physical file the legacy client uses.
 * Prisma resolves a relative `file:` path against the schema directory; the
 * legacy schema lives in `prisma/` (so it targets `prisma/data/...`) while this
 * client is generated from `prisma/local/`. Pin both to the same file via an
 * absolute path. Absolute URLs (e.g. Fly `file:/data/...`) pass through as-is.
 */
function resolveLocalSqliteUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw || !raw.startsWith('file:')) return raw;
  const rel = raw.slice('file:'.length);
  if (path.isAbsolute(rel)) return raw;
  return `file:${path.resolve(process.cwd(), 'prisma', rel)}`;
}

/**
 * Local SQLite cache client.
 * Use only for restart-recovery and bounded outbox/cache data.
 */
const localUrl = resolveLocalSqliteUrl();

export const localPrisma = new PrismaClient({
  ...(localUrl ? { datasources: { db: { url: localUrl } } } : {}),
  log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
});

export async function disconnectLocalPrisma(): Promise<void> {
  await localPrisma.$disconnect();
}
