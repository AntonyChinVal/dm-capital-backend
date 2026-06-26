import { PrismaClient } from '../generated/durable-client/index.js';

/**
 * Durable Postgres client (Neon).
 * Use for historical data, DVOL rank series, and Fase H signal snapshots.
 */
export const durablePrisma = new PrismaClient({
  log: process.env.PRISMA_LOG === '1' ? ['warn', 'error'] : ['error'],
});

export async function disconnectDurablePrisma(): Promise<void> {
  await durablePrisma.$disconnect();
}
