/**
 * English copy dictionary for Panorama tiles.
 *
 * Tone: descriptive only, no predictive verbs (read-only product lock).
 * What happened, what the data shows. Not what will happen.
 *
 * TODO: calibration session — text may be refined.
 */
import type { NetFlowState, RegimenState, SesgoState } from './classifiers.js';
import type { RangeTrendState } from './rangeTrend.js';

export interface Fragment {
  label: string;
  sub: string;
}

export const REGIMEN_FRAGMENTS: Record<RegimenState, Fragment> = {
  positive_amplio: {
    label: 'Positive gamma',
    sub: 'Spot well above the flip — settled band.',
  },
  positive_ajustado: {
    label: 'Positive gamma',
    sub: 'Spot above the flip — transition band.',
  },
  positive_critico: {
    label: 'Positive gamma',
    sub: 'Spot near the gamma flip.',
  },
  negative_critico: {
    label: 'Negative gamma',
    sub: 'Spot near the gamma flip.',
  },
  negative_ajustado: {
    label: 'Negative gamma',
    sub: 'Spot below the flip — transition band.',
  },
  negative_amplio: {
    label: 'Negative gamma',
    sub: 'Spot well below the flip — settled band.',
  },
  unknown: {
    label: 'Calculating',
    sub: 'Waiting for GEX and gamma flip.',
  },
};

export const SESGO_FRAGMENTS: Record<SesgoState, Fragment> = {
  euforia: {
    label: 'Euphoria',
    sub: 'Calls priced richer than puts — upside bias dominant.',
  },
  neutral: {
    label: 'Neutral',
    sub: 'Skew shows no pronounced directional bias.',
  },
  defensivo: {
    label: 'Defensive',
    sub: 'Puts priced richer than calls — protection bid.',
  },
  miedo: {
    label: 'High fear',
    sub: 'Structural skew elevated — puts dominate across tenors.',
  },
  unknown: {
    label: 'Calculating',
    sub: 'Waiting for front-month 25Δ skew.',
  },
};

export const NETFLOW_FRAGMENTS: Record<NetFlowState, Fragment> = {
  alcista_fuerte: {
    label: 'Strong bullish flow',
    sub: 'Signed net distinctly positive over the window.',
  },
  alcista: {
    label: 'Bullish flow',
    sub: 'Directional upward bias over the window.',
  },
  neutral: {
    label: 'Neutral flow',
    sub: 'No dominant directional bias.',
  },
  bajista: {
    label: 'Bearish flow',
    sub: 'Directional downward bias over the window.',
  },
  bajista_fuerte: {
    label: 'Strong bearish flow',
    sub: 'Signed net distinctly negative over the window.',
  },
  unknown: {
    label: 'Calculating',
    sub: 'Accumulating flow over the window.',
  },
};

export const RANGETREND_FRAGMENTS: Record<RangeTrendState, Fragment> = {
  range: {
    label: 'Range',
    sub: 'Spot between the walls — mid-corridor.',
  },
  'trend-up': {
    label: 'Trending up',
    sub: 'Spot near the call wall.',
  },
  'trend-down': {
    label: 'Trending down',
    sub: 'Spot near the put wall.',
  },
  unknown: {
    label: 'Calculating',
    sub: 'Waiting for call wall and put wall.',
  },
};

/** Distance-aware regime subtext (descriptive only). */
export function regimenSub(spot: number, flip: number, state: RegimenState): string {
  const distPct = ((spot - flip) / spot) * 100;
  const sign = distPct >= 0 ? '+' : '';
  const dir = distPct >= 0 ? 'above' : 'below';
  const dist = `${sign}${distPct.toFixed(1)}% ${dir} the gamma flip`;
  const signLabel = state.startsWith('positive') ? 'positive' : 'negative';

  if (state.endsWith('_amplio')) {
    return `Spot ${dist} — settled ${signLabel} gamma band.`;
  }
  if (state.endsWith('_ajustado')) {
    return `Spot ${dist} — transition band.`;
  }
  return `Spot ${dist} — near the gamma flip.`;
}

export type Severity = 'info' | 'warn' | 'critical' | 'unknown';

export function regimenSeverity(state: RegimenState): Severity {
  if (state === 'unknown') return 'unknown';
  if (state === 'negative_critico') return 'critical';
  if (state === 'positive_critico' || state === 'negative_ajustado') return 'warn';
  return 'info';
}

export function sesgoSeverity(state: SesgoState): Severity {
  if (state === 'unknown') return 'unknown';
  if (state === 'miedo') return 'critical';
  if (state === 'defensivo' || state === 'euforia') return 'warn';
  return 'info';
}

export function netflowSeverity(state: NetFlowState): Severity {
  if (state === 'unknown') return 'unknown';
  if (state === 'alcista_fuerte' || state === 'bajista_fuerte') return 'warn';
  return 'info';
}

export function rangetrendSeverity(state: RangeTrendState): Severity {
  if (state === 'unknown') return 'unknown';
  return 'info';
}
