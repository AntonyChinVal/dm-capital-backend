-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "expiration" TEXT NOT NULL,
    "future" REAL NOT NULL,
    "maxPain" REAL,
    "gammaFlip" REAL,
    "callWall" REAL,
    "putWall" REAL,
    "regime" TEXT NOT NULL,
    "oiSummary" TEXT NOT NULL,
    "gexSummary" TEXT NOT NULL,
    "atmIv" REAL,
    "count" INTEGER NOT NULL,
    "gexCovered" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "SurfaceSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "headlineSkew" REAL,
    "termStructure" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "FlowTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL,
    "expiration" TEXT NOT NULL,
    "strike" REAL NOT NULL,
    "type" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "notionalUsd" REAL NOT NULL,
    "signedNotional" REAL NOT NULL,
    "iv" REAL,
    "priorIv" REAL,
    "ivDelta" REAL,
    "interp" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "FlowAggregateSnapshot" (
    "ts" DATETIME NOT NULL PRIMARY KEY,
    "buckets" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firstSeen" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "contextJson" TEXT
);

-- CreateTable
CREATE TABLE "IndexTick" (
    "ts" DATETIME NOT NULL PRIMARY KEY,
    "indexName" TEXT NOT NULL DEFAULT 'btc_usd',
    "price" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "MetricSnapshot_currency_expiration_ts_idx" ON "MetricSnapshot"("currency", "expiration", "ts");

-- CreateIndex
CREATE INDEX "MetricSnapshot_ts_idx" ON "MetricSnapshot"("ts");

-- CreateIndex
CREATE INDEX "SurfaceSnapshot_currency_ts_idx" ON "SurfaceSnapshot"("currency", "ts");

-- CreateIndex
CREATE INDEX "FlowTrade_ts_idx" ON "FlowTrade"("ts");

-- CreateIndex
CREATE INDEX "FlowTrade_expiration_ts_idx" ON "FlowTrade"("expiration", "ts");

-- CreateIndex
CREATE INDEX "FlowTrade_tag_ts_idx" ON "FlowTrade"("tag", "ts");

-- CreateIndex
CREATE INDEX "AlertLog_firstSeen_idx" ON "AlertLog"("firstSeen");

-- CreateIndex
CREATE INDEX "AlertLog_kind_severity_idx" ON "AlertLog"("kind", "severity");

-- CreateIndex
CREATE INDEX "IndexTick_indexName_ts_idx" ON "IndexTick"("indexName", "ts");
