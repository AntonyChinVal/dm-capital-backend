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
  type Severity,
  netflowSeverity,
  rangetrendSeverity,
  regimenSeverity,
  sesgoSeverity,
} from './fragments.js';
import { type RangeTrendState, classifyRangeTrend } from './rangeTrend.js';

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
}

export function buildPanorama(inputs: SynthesisInputs): PanoramaTile[] {
  const regimen = classifyRegimen(inputs.spot, inputs.gammaFlip);
  const sesgo = classifySesgo(inputs.headlineSkew);
  const netflow = classifyNetFlow(inputs.deltaFlowUsd ?? inputs.signedNotional);
  const rangetrend = classifyRangeTrend(inputs.spot, inputs.callWall, inputs.putWall);

  return [
    {
      dimension: 'regimen',
      state: regimen,
      severity: regimenSeverity(regimen),
      label: REGIMEN_FRAGMENTS[regimen].label,
      sub:
        inputs.spot != null && inputs.gammaFlip != null
          ? regimenSub(inputs.spot, inputs.gammaFlip, regimen)
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
      ...RANGETREND_FRAGMENTS[rangetrend],
    },
  ];
}

/**
 * "Puente GEX × vencimiento" — short interpretive text shown below the
 * GEX chart. Connects the gamma walls to the temporal context (which
 * OPEX releases the pressure).
 */
export function buildBridgeText(
  callWall: number | null,
  putWall: number | null,
  nextOpex: { expiration: string; tag: string } | null,
): string {
  if (callWall == null || putWall == null) {
    return 'Waiting for walls to bracket the active range.';
  }
  const callStr = '$' + Math.round(callWall).toLocaleString();
  const putStr = '$' + Math.round(putWall).toLocaleString();
  if (!nextOpex) {
    return `Active range ${putStr} – ${callStr}.`;
  }
  const opexKind = nextOpex.tag === 'Q' ? 'quarterly OPEX' : 'monthly OPEX';
  return `Active range ${putStr} – ${callStr}. Releases after the ${opexKind} on ${nextOpex.expiration}.`;
}
