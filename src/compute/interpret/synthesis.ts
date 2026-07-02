import {
  type NetFlowState,
  type RegimenState,
  type SesgoState,
  classifyNetFlow,
  classifyRegimen,
  classifySesgo,
} from './classifiers.js';
import {
  NETFLOW_FRAGMENTS,
  REGIMEN_FRAGMENTS,
  RANGETREND_FRAGMENTS,
  SESGO_FRAGMENTS,
  regimenSub,
  rangetrendSub,
  type Severity,
  netflowSeverity,
  rangetrendSeverity,
  regimenSeverity,
  sesgoSeverity,
} from './fragments.js';
import { type RangeTrendState, classifyRangeTrend } from './rangeTrend.js';
import type { DominantGammaExpiry } from '../gex.js';

export type TileDimension = 'regimen' | 'sesgo' | 'netflow' | 'rangetrend';

export interface PanoramaTile {
  dimension: TileDimension;
  state: RegimenState | SesgoState | NetFlowState | RangeTrendState;
  severity: Severity;
  label: string;
  sub: string;
}

export interface SynthesisInputs {
  spot: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  headlineSkew: number | null;
  signedNotional: number | null;
  deltaFlowUsd?: number | null;
  /** Daily 1σ EM (24h blend) for σ-proximity copy in Panorama. */
  em1sigmaDaily?: number | null;
}

export function buildPanorama(inputs: SynthesisInputs): PanoramaTile[] {
  const regimen = classifyRegimen(inputs.spot, inputs.gammaFlip);
  const sesgo = classifySesgo(inputs.headlineSkew);
  const netflow = classifyNetFlow(inputs.deltaFlowUsd ?? inputs.signedNotional);
  const rangetrend = classifyRangeTrend(inputs.spot, inputs.callWall, inputs.putWall);
  const em1sigma = inputs.em1sigmaDaily ?? null;

  return [
    {
      dimension: 'regimen',
      state: regimen,
      severity: regimenSeverity(regimen),
      label: REGIMEN_FRAGMENTS[regimen].label,
      sub:
        inputs.spot != null && inputs.gammaFlip != null
          ? regimenSub(inputs.spot, inputs.gammaFlip, regimen, em1sigma)
          : REGIMEN_FRAGMENTS[regimen].sub,
    },
    {
      dimension: 'sesgo',
      state: sesgo,
      severity: sesgoSeverity(sesgo),
      ...SESGO_FRAGMENTS[sesgo],
    },
    {
      dimension: 'netflow',
      state: netflow,
      severity: netflowSeverity(netflow),
      ...NETFLOW_FRAGMENTS[netflow],
    },
    {
      dimension: 'rangetrend',
      state: rangetrend,
      severity: rangetrendSeverity(rangetrend),
      label: RANGETREND_FRAGMENTS[rangetrend].label,
      sub:
        inputs.spot != null && inputs.callWall != null && inputs.putWall != null
          ? rangetrendSub(inputs.spot, inputs.callWall, inputs.putWall, rangetrend, em1sigma)
          : RANGETREND_FRAGMENTS[rangetrend].sub,
    },
  ];
}

export interface BridgeReleaseContext {
  dominant: DominantGammaExpiry | null;
  nextOpex: { expiration: string; tag: string } | null;
}

export interface BridgeTextResult {
  text: string;
  critical: boolean;
}

function formatCountdown(hoursLeft: number): string {
  if (hoursLeft < 1) return `${Math.round(hoursLeft * 60)}m`;
  if (hoursLeft < 24) return `${hoursLeft.toFixed(1)}h`;
  return `${(hoursLeft / 24).toFixed(1)}d`;
}

/**
 * "Puente GEX × vencimiento" — short interpretive text shown below the
 * GEX chart. Attributes gamma release to the expiry with the largest
 * aggregated share in the active range (local cascade → local resistance).
 */
export function buildBridgeText(
  callWall: number | null,
  putWall: number | null,
  release: BridgeReleaseContext,
): BridgeTextResult {
  if (callWall == null || putWall == null) {
    return { text: 'Waiting for walls to bracket the active range.', critical: false };
  }
  const callStr = '$' + Math.round(callWall).toLocaleString();
  const putStr = '$' + Math.round(putWall).toLocaleString();
  const rangePart = `Active range ${putStr} – ${callStr}`;

  const { dominant, nextOpex } = release;
  if (dominant) {
    const countdown = formatCountdown(dominant.hoursLeft);
    const pct = Math.round(dominant.sharePct);
    const critical = dominant.hoursLeft < 24;
    return {
      text: `${rangePart} · ${pct}% of this gamma expires in ${countdown} (${dominant.expiration}).`,
      critical,
    };
  }

  if (!nextOpex) {
    return { text: `${rangePart}.`, critical: false };
  }
  const opexKind = nextOpex.tag === 'Q' ? 'quarterly OPEX' : 'monthly OPEX';
  return {
    text: `${rangePart}. Releases after the ${opexKind} on ${nextOpex.expiration}.`,
    critical: false,
  };
}
