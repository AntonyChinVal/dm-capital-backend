-- SignalSnapshot: document GEX unit explicitly for backtest compatibility.
ALTER TABLE "SignalSnapshot" ADD COLUMN IF NOT EXISTS "gexUnit" TEXT NOT NULL DEFAULT 'usd_per_1usd_move';
