import { PrismaClient } from '@prisma/client';

/**
 * Prisma singleton — shared across writers and read handlers.
 * SQLite (Hernán Q21.a). Same-process writes (B11.3).
 */
export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
