/**
 * C3 duplicate audit on Neon (MetricSnapshot / SurfaceSnapshot).
 * Usage:
 *   pnpm exec tsx scripts/audit-dedupe.ts
 *   pnpm exec tsx scripts/audit-dedupe.ts --dedupe
 */
import { durablePrisma, disconnectDurablePrisma } from '../src/db/durable.js';

type DupeRow = { currency: string; expiration?: string; ts: Date; n: bigint };

const dedupe = process.argv.includes('--dedupe');

async function runDedupe(): Promise<{ metricDeleted: number; surfaceDeleted: number }> {
  const metric = await durablePrisma.$executeRaw`
    DELETE FROM "MetricSnapshot" m
    USING "MetricSnapshot" m2
    WHERE m.currency = m2.currency
      AND m.expiration = m2.expiration
      AND m.ts = m2.ts
      AND m.id > m2.id
  `;
  const surface = await durablePrisma.$executeRaw`
    DELETE FROM "SurfaceSnapshot" s
    USING "SurfaceSnapshot" s2
    WHERE s.currency = s2.currency
      AND s.ts = s2.ts
      AND s.id > s2.id
  `;
  return { metricDeleted: Number(metric), surfaceDeleted: Number(surface) };
}

async function main() {
  if (dedupe) {
    const deleted = await runDedupe();
    console.log('=== Neon dedupe ===');
    console.log(JSON.stringify(deleted, null, 2));
  }

  const [metricCount, surfaceCount] = await Promise.all([
    durablePrisma.metricSnapshot.count(),
    durablePrisma.surfaceSnapshot.count(),
  ]);

  const metricDupes = await durablePrisma.$queryRaw<DupeRow[]>`
    SELECT currency, expiration, ts, COUNT(*)::bigint AS n
    FROM "MetricSnapshot"
    GROUP BY currency, expiration, ts
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `;

  const surfaceDupes = await durablePrisma.$queryRaw<DupeRow[]>`
    SELECT currency, ts, COUNT(*)::bigint AS n
    FROM "SurfaceSnapshot"
    GROUP BY currency, ts
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `;


  const [metricGroupsTotal, surfaceGroupsTotal, metricExtraTotal, surfaceExtraTotal] =
    await Promise.all([
      durablePrisma.$queryRaw<[{ n: bigint }]>`
        SELECT COUNT(*)::bigint AS n FROM (
          SELECT 1 FROM "MetricSnapshot"
          GROUP BY currency, expiration, ts
          HAVING COUNT(*) > 1
        ) t
      `,
      durablePrisma.$queryRaw<[{ n: bigint }]>`
        SELECT COUNT(*)::bigint AS n FROM (
          SELECT 1 FROM "SurfaceSnapshot"
          GROUP BY currency, ts
          HAVING COUNT(*) > 1
        ) t
      `,
      durablePrisma.$queryRaw<[{ extra: bigint }]>`
        SELECT COALESCE(SUM(cnt - 1), 0)::bigint AS extra FROM (
          SELECT COUNT(*) AS cnt FROM "MetricSnapshot"
          GROUP BY currency, expiration, ts
          HAVING COUNT(*) > 1
        ) t
      `,
      durablePrisma.$queryRaw<[{ extra: bigint }]>`
        SELECT COALESCE(SUM(cnt - 1), 0)::bigint AS extra FROM (
          SELECT COUNT(*) AS cnt FROM "SurfaceSnapshot"
          GROUP BY currency, ts
          HAVING COUNT(*) > 1
        ) t
      `,
    ]);

  console.log('=== Neon duplicate audit ===');
  console.log(
    JSON.stringify(
      {
        metricSnapshot: {
          totalRows: metricCount,
          duplicateGroups: Number(metricGroupsTotal[0].n),
          extraRowsBeyondUnique: Number(metricExtraTotal[0].extra),
          topExamples: metricDupes.slice(0, 5).map((r) => ({
            currency: r.currency,
            expiration: r.expiration,
            ts: r.ts.toISOString(),
            count: Number(r.n),
          })),
        },
        surfaceSnapshot: {
          totalRows: surfaceCount,
          duplicateGroups: Number(surfaceGroupsTotal[0].n),
          extraRowsBeyondUnique: Number(surfaceExtraTotal[0].extra),
          topExamples: surfaceDupes.slice(0, 5).map((r) => ({
            currency: r.currency,
            ts: r.ts.toISOString(),
            count: Number(r.n),
          })),
        },
        c3MigrationSafe:
          Number(metricGroupsTotal[0].n) === 0 && Number(surfaceGroupsTotal[0].n) === 0,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDurablePrisma());
