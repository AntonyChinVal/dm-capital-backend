-- Local SQLite outbox for bounded durable writes.
-- This is a short-lived cache only; Neon Postgres remains the durable source.

CREATE TABLE "DurableOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT
);

CREATE INDEX "DurableOutbox_kind_createdAt_idx" ON "DurableOutbox"("kind", "createdAt");
CREATE INDEX "DurableOutbox_createdAt_idx" ON "DurableOutbox"("createdAt");
