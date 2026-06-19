import { THRESHOLDS } from './thresholds.js';

export type RegimenState =
  | 'positive_amplio'
  | 'positive_ajustado'
  | 'positive_critico'
  | 'negative_critico'
  | 'negative_ajustado'
  | 'negative_amplio'
  | 'unknown';

export function classifyRegimen(spot: number | null, gammaFlip: number | null): RegimenState {
  if (spot == null || gammaFlip == null || spot <= 0) return 'unknown';
  const dist = (spot - gammaFlip) / spot;
  const { settled, transition } = THRESHOLDS.bufferFlip;
  const abs = Math.abs(dist);
  const sign = dist >= 0 ? 'positive' : 'negative';
  let band: 'amplio' | 'ajustado' | 'critico';
  if (abs > settled) band = 'amplio';
  else if (abs > transition) band = 'ajustado';
  else band = 'critico';
  return `${sign}_${band}` as RegimenState;
}

export type SesgoState = 'euforia' | 'neutral' | 'defensivo' | 'miedo' | 'unknown';

export function classifySesgo(headlineSkew: number | null): SesgoState {
  if (headlineSkew == null || !Number.isFinite(headlineSkew)) return 'unknown';
  const { miedo, defensivo, euforia } = THRESHOLDS.skew;
  if (headlineSkew > miedo) return 'miedo';
  if (headlineSkew > defensivo) return 'defensivo';
  if (headlineSkew < euforia) return 'euforia';
  return 'neutral';
}

export type NetFlowState =
  | 'bajista_fuerte'
  | 'bajista'
  | 'neutral'
  | 'alcista'
  | 'alcista_fuerte'
  | 'unknown';

export function classifyNetFlow(signedNotional: number | null): NetFlowState {
  if (signedNotional == null || !Number.isFinite(signedNotional)) return 'unknown';
  const { fuerte, moderado } = THRESHOLDS.netFlow;
  if (signedNotional > fuerte) return 'alcista_fuerte';
  if (signedNotional > moderado) return 'alcista';
  if (signedNotional < -fuerte) return 'bajista_fuerte';
  if (signedNotional < -moderado) return 'bajista';
  return 'neutral';
}
