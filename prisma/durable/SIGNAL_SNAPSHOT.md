# SignalSnapshot — durable contract

> Source of truth: `backend/prisma/durable/schema.prisma`  
> Writer: `backend/src/state/signalSnapshot.ts` · flush: `durableBatcher.ts`

One row per minute (UTC, truncated). Scalars + optional `ivGridByDelta` JSON. Never raw Deribit chain dumps.

## schemaVersion history

| Version | Change |
|---------|--------|
| **v1** | Initial scalars (spot, dvol, skews, gex, walls, flows) |
| **v2** | `gexUnit = usd_per_1usd_move` explicit |
| **v3** | `ivGridByDelta` Json — IV surface at constant tenors |

Bump `schemaVersion` only on irreversible contract changes. Old rows keep their version.

## Units and NULL policy

| Field | Unit | NULL means |
|-------|------|------------|
| `spot` | USD | not measured |
| `dvol` | vol % (46.3 = 46.3%) | not measured |
| `skew7d`…`skew180d` | vol points (put25Δ − call25Δ) at constant tenor | not measured |
| `gexNet` | USD gamma exposure per **$1** spot move | not measured |
| `gexUnit` | always `usd_per_1usd_move` (v2+) | — |
| `gammaFlip`, `callWall`, `cascadeWall` | USD strike | not measured |
| `dexNet`, `vexNet`, flows | USD | not measured |
| `flow*` | NULL when window has zero trades (`count > 0` guard) | no trades |
| `ivGridByDelta` | vol % per delta key | tenor or point not measured |

**Never coerce missing values to `0`.** A stored `0` means “measured as zero”.

## SSR vector (co-timestamp)

`spot`, `dvol`, and `skew30d` share the same `ts` (minute bucket).  
`skew30d` = 25Δ skew interpolated to **30D constant tenor** (SSR reference).

## ivGridByDelta (schema v3)

Json object — constant tenors × 7 delta points. Built by `buildIvGridByConstantTenor()`.

```json
{
  "7D":  { "-10": 47.4, "-20": 42.5, "-35": 38.9, "ATM": 36.9, "35": 34.9, "20": 34.2, "10": 34.3 },
  "30D": { ... },
  "90D": { ... },
  "180D": { ... }
}
```

| Rule | Detail |
|------|--------|
| Tenors | 7D / 30D / 90D / 180D — interpolated across calendar expirations |
| Deltas | −10, −20, −35, ATM, +35, +20, +10 (put/call wings + ATM) |
| Interpolation | Black-76 delta; linear across tenor days between bracketing expiries |
| Missing | key omitted or `null` — **never `0`** |
| vs UI surface | Calendar-expiry surface (21 cols) is separate; this grid is for backtest |

## Compute references

| Topic | Module |
|-------|--------|
| Gamma flip / walls | `compute/gex.ts`, `metricsBundle.ts` |
| Liquidity filter | `filterLiquidStrikes()` — markIv > 0, OI/vol > 0, strikes 0.4×–2.5× forward |
| Skew / IV interp | `skew.ts`, `ivGridByTenor.ts` |
| GEX unit | `gexNet = gamma × OI × spot` → USD per $1 move |

## SignalStrikeSnapshot

Table exists in schema; **no writer in v3** (Hernán Q3:A). Strike-level arrays deferred until explicit contract.

## Retention

`signal_snapshot` rows in Neon: **no aggressive prune** (long-lived backtest dataset).  
Separate from `HISTORY_RETENTION_DAYS` (180d) which applies to metrics/surface/index/alerts.
