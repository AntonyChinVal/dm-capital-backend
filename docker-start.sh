#!/bin/sh
# Container start: apply local SQLite migrations, then boot the service.
#
# Self-heals a half-applied/failed migration (Prisma P3009): if `migrate deploy`
# fails, mark the known-failed migration as rolled back and retry once. On a
# healthy boot the first deploy succeeds and the recovery branch is skipped, so
# this is safe to keep permanently and idempotent across restarts.
set -e

SCHEMA="prisma/schema.prisma"
FAILED_MIGRATION="20260626042500_add_durable_outbox"

if ! pnpm exec prisma migrate deploy --schema "$SCHEMA"; then
  echo "[start] migrate deploy failed — rolling back '$FAILED_MIGRATION' and retrying once"
  pnpm exec prisma migrate resolve --rolled-back "$FAILED_MIGRATION" --schema "$SCHEMA" || true
  pnpm exec prisma migrate deploy --schema "$SCHEMA"
fi

exec node dist/index.js
