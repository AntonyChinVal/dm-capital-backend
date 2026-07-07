-- SignalSnapshot schema v3: irreversible IV surface grid at constant tenors.
ALTER TABLE "SignalSnapshot" ADD COLUMN IF NOT EXISTS "ivGridByDelta" JSONB;
