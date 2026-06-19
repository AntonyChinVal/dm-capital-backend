/**
 * Interpretation thresholds — placeholders from guide v4 §6.
 *
 * TODO: calibrar con Hernán (Q12) — 30-minute live-dashboard session.
 *       Each value here is a guess until that conversation happens.
 *
 * Hot-swap safe: change values → restart backend → new thresholds apply.
 * No DB write of thresholds, no historical re-tag needed.
 */
export const THRESHOLDS = {
  // % distance spot ↔ gamma flip (Regime tile) — calibrated 19-Jun-2026
  bufferFlip: {
    settled: 0.04,      // > 4%  → wide buffer / settled
    transition: 0.02,     // 2–4% → transition band
    // < 2% → near flip / imminent
  },

  // 25Δ headline skew thresholds (Sesgo tile) — already in skewMood.ts, mirrored here
  skew: {
    miedo: 8,       // > 8% → miedo alto
    defensivo: 3,   // 3-8% → defensivo
    // -3 to 3 → neutral
    euforia: -3,    // < -3% → euforia (calls caras)
  },

  // Net flow magnitude (Neto tile), in USD
  netFlow: {
    fuerte: 1_000_000,   // |signedNotional| > $1M → fuerte
    moderado: 100_000,   // > $100K → moderado
    // < $100K → neutro
  },

  // Spot position between walls (Rango tile, B9.2 algorithm)
  rangeTrend: {
    // Middle third of the call/put wall corridor → "rango"
    centralLow: 0.33,
    centralHigh: 0.67,
  },

  // SkewTiles target tenors (B9.3 algorithm)
  skewTiles: {
    targetsDays: [7, 30, 90, 180] as const,
    deviationLabelThreshold: 0.20, // > 20% off target → show actual days
  },
} as const;
