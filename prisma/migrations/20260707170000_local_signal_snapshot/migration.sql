-- Local mirror for signal_snapshot (Fase 9 local-first readers).
CREATE TABLE "SignalSnapshot" (
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "ts" DATETIME NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "spot" REAL,
    "dvol" REAL,
    "skew7d" REAL,
    "skew30d" REAL,
    "skew90d" REAL,
    "skew180d" REAL,
    "gexNet" REAL,
    "gexUnit" TEXT NOT NULL DEFAULT 'usd_per_1usd_move',
    "gammaFlip" REAL,
    "callWall" REAL,
    "cascadeWall" REAL,
    "dexNet" REAL,
    "vexNet" REAL,
    "flowDeltaNet" REAL,
    "flowVegaNet" REAL,
    "flowPremiumNet" REAL,
    "regimeLabel" TEXT,
    "ivGridByDelta" TEXT,
    PRIMARY KEY ("ts", "currency")
);

CREATE INDEX "SignalSnapshot_currency_ts_idx" ON "SignalSnapshot"("currency", "ts");
