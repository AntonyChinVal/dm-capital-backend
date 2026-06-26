-- Add VEX net to the Fase H signal snapshot contract.
-- Unit: USD delta-notional change per 1 point of IV.
ALTER TABLE "SignalSnapshot" ADD COLUMN "vexNet" DOUBLE PRECISION;

COMMENT ON COLUMN "SignalSnapshot"."vexNet" IS 'Unit: USD delta-notional change per 1 point of IV. NULL until VEX exists; 0 means measured neutral.';
