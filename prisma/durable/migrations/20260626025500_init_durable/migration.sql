-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "expiration" TEXT NOT NULL,
    "future" DOUBLE PRECISION NOT NULL,
    "maxPain" DOUBLE PRECISION,
    "gammaFlip" DOUBLE PRECISION,
    "callWall" DOUBLE PRECISION,
    "putWall" DOUBLE PRECISION,
    "regime" TEXT NOT NULL,
    "oiSummary" JSONB NOT NULL,
    "gexSummary" JSONB NOT NULL,
    "atmIv" DOUBLE PRECISION,
    "count" INTEGER NOT NULL,
    "gexCovered" INTEGER NOT NULL,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurfaceSnapshot" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "headlineSkew" DOUBLE PRECISION,
    "termStructure" JSONB NOT NULL,

    CONSTRAINT "SurfaceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowTrade" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "expiration" TEXT NOT NULL,
    "strike" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "notionalUsd" DOUBLE PRECISION NOT NULL,
    "signedNotional" DOUBLE PRECISION NOT NULL,
    "iv" DOUBLE PRECISION,
    "priorIv" DOUBLE PRECISION,
    "ivDelta" DOUBLE PRECISION,
    "interp" TEXT NOT NULL,

    CONSTRAINT "FlowTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "contextJson" JSONB,

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexTick" (
    "ts" TIMESTAMP(3) NOT NULL,
    "indexName" TEXT NOT NULL DEFAULT 'btc_usd',
    "price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "IndexTick_pkey" PRIMARY KEY ("ts","indexName")
);

-- CreateTable
CREATE TABLE "DvolTick" (
    "ts" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "DvolTick_pkey" PRIMARY KEY ("ts","currency")
);

-- CreateTable
CREATE TABLE "SignalSnapshot" (
    "ts" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "flowSignedNotional" DOUBLE PRECISION NOT NULL,
    "flowBuyCount" INTEGER NOT NULL,
    "flowSellCount" INTEGER NOT NULL,
    "dvol" DOUBLE PRECISION,
    "indexPrice" DOUBLE PRECISION,
    "headlineSkew" DOUBLE PRECISION,

    CONSTRAINT "SignalSnapshot_pkey" PRIMARY KEY ("ts","currency")
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

-- CreateIndex
CREATE INDEX "DvolTick_currency_ts_idx" ON "DvolTick"("currency", "ts");

-- CreateIndex
CREATE INDEX "SignalSnapshot_currency_ts_idx" ON "SignalSnapshot"("currency", "ts");
