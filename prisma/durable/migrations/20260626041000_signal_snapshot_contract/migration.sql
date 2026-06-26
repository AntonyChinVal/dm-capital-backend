-- SignalSnapshot contract update for Fase H backtesting.
-- All timestamps are UTC. Empty/future fields are NULL, never 0.

ALTER TABLE "SignalSnapshot"
  ALTER COLUMN "ts" TYPE TIMESTAMPTZ(3) USING "ts" AT TIME ZONE 'UTC';

ALTER TABLE "SignalSnapshot"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "SignalSnapshot"
  RENAME COLUMN "indexPrice" TO "spot";

ALTER TABLE "SignalSnapshot"
  DROP COLUMN "flowSignedNotional",
  DROP COLUMN "flowBuyCount",
  DROP COLUMN "flowSellCount",
  DROP COLUMN "headlineSkew",
  ADD COLUMN "skew7d" DOUBLE PRECISION,
  ADD COLUMN "skew30d" DOUBLE PRECISION,
  ADD COLUMN "skew90d" DOUBLE PRECISION,
  ADD COLUMN "skew180d" DOUBLE PRECISION,
  ADD COLUMN "gexNet" DOUBLE PRECISION,
  ADD COLUMN "gammaFlip" DOUBLE PRECISION,
  ADD COLUMN "callWall" DOUBLE PRECISION,
  ADD COLUMN "cascadeWall" DOUBLE PRECISION,
  ADD COLUMN "dexNet" DOUBLE PRECISION,
  ADD COLUMN "flowDeltaNet" DOUBLE PRECISION,
  ADD COLUMN "flowVegaNet" DOUBLE PRECISION,
  ADD COLUMN "flowPremiumNet" DOUBLE PRECISION,
  ADD COLUMN "regimeLabel" TEXT;

CREATE TABLE "SignalStrikeSnapshot" (
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTC',
    "kind" TEXT NOT NULL,
    "cadenceMinutes" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "SignalStrikeSnapshot_pkey" PRIMARY KEY ("ts","currency","kind")
);

CREATE INDEX "SignalStrikeSnapshot_currency_kind_ts_idx" ON "SignalStrikeSnapshot"("currency", "kind", "ts");

COMMENT ON TABLE "SignalSnapshot" IS 'One row per minute with terminal-computed scalar signals for backtesting. No raw option-chain dumps.';
COMMENT ON COLUMN "SignalSnapshot"."schemaVersion" IS 'Schema contract version for backtest compatibility.';
COMMENT ON COLUMN "SignalSnapshot"."ts" IS 'UTC timestamp of the terminal snapshot, truncated to the minute.';
COMMENT ON COLUMN "SignalSnapshot"."spot" IS 'Unit: USD spot/index price shown by the terminal.';
COMMENT ON COLUMN "SignalSnapshot"."dvol" IS 'Unit: volatility index percent, e.g. 46.3 means 46.3%.';
COMMENT ON COLUMN "SignalSnapshot"."skew7d" IS 'Unit: vol percentage-point skew at constant 7D maturity.';
COMMENT ON COLUMN "SignalSnapshot"."skew30d" IS 'Unit: vol percentage-point skew at constant 30D maturity.';
COMMENT ON COLUMN "SignalSnapshot"."skew90d" IS 'Unit: vol percentage-point skew at constant 90D maturity.';
COMMENT ON COLUMN "SignalSnapshot"."skew180d" IS 'Unit: vol percentage-point skew at constant 180D maturity.';
COMMENT ON COLUMN "SignalSnapshot"."gexNet" IS 'Unit: USD gamma exposure per 1% move.';
COMMENT ON COLUMN "SignalSnapshot"."gammaFlip" IS 'Unit: USD strike level where net gamma flips sign.';
COMMENT ON COLUMN "SignalSnapshot"."callWall" IS 'Unit: USD strike level of strongest positive GEX / call wall.';
COMMENT ON COLUMN "SignalSnapshot"."cascadeWall" IS 'Unit: USD strike level of most negative GEX / put-heavy cascade wall below spot.';
COMMENT ON COLUMN "SignalSnapshot"."dexNet" IS 'Unit: USD delta notional. NULL until DEX exists; 0 means measured neutral.';
COMMENT ON COLUMN "SignalSnapshot"."flowDeltaNet" IS 'Unit: USD notional, delta-weighted flow. NULL until measured.';
COMMENT ON COLUMN "SignalSnapshot"."flowVegaNet" IS 'Unit: USD notional, vega-weighted flow. NULL until measured.';
COMMENT ON COLUMN "SignalSnapshot"."flowPremiumNet" IS 'Unit: USD premium/notional flow. NULL until measured.';
COMMENT ON COLUMN "SignalSnapshot"."regimeLabel" IS 'Regime label displayed by the terminal. NULL until rules exist.';

COMMENT ON TABLE "SignalStrikeSnapshot" IS 'Strike-level arrays written at slower cadence (5-15 min). Payloads are computed arrays, never raw Deribit option-chain dumps.';
COMMENT ON COLUMN "SignalStrikeSnapshot"."schemaVersion" IS 'Schema contract version for backtest compatibility.';
COMMENT ON COLUMN "SignalStrikeSnapshot"."ts" IS 'UTC timestamp of this strike-level snapshot.';
COMMENT ON COLUMN "SignalStrikeSnapshot"."kind" IS 'Payload family, e.g. gex_by_strike, dex_by_strike, oi_by_strike.';
COMMENT ON COLUMN "SignalStrikeSnapshot"."cadenceMinutes" IS 'Intended write cadence in minutes, usually 5-15.';
COMMENT ON COLUMN "SignalStrikeSnapshot"."payload" IS 'Unit: JSON arrays by strike; never raw Deribit option-chain dump.';
