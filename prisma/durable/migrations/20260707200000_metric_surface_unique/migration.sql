-- CreateIndex
CREATE UNIQUE INDEX "MetricSnapshot_currency_expiration_ts_key" ON "MetricSnapshot"("currency", "expiration", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "SurfaceSnapshot_currency_ts_key" ON "SurfaceSnapshot"("currency", "ts");
