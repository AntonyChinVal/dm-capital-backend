-- CreateTable
CREATE TABLE "DvolTick" (
    "ts" DATETIME NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "value" REAL NOT NULL,

    PRIMARY KEY ("ts", "currency")
);

-- CreateIndex
CREATE INDEX "DvolTick_currency_ts_idx" ON "DvolTick"("currency", "ts");
