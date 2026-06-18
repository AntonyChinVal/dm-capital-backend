import type { FlowEvent } from './tradeFlow.js';

export type AlertKind = 'flip' | 'wall' | 'block' | 'skew';
export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface Alert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  ts: number;
  title: string;
  message: string;
  context?: Record<string, unknown>;
}

function fmt(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

function hourBucket(ms = Date.now()): number {
  return Math.floor(ms / (60 * 60 * 1000));
}

function halfHourBucket(ms = Date.now()): number {
  return Math.floor(ms / (30 * 60 * 1000));
}

/* ============== Gamma-flip crossing ============== */

const flipSide = new Map<string, 'above' | 'below'>();

export function checkFlipCross(expiration: string, future: number, gammaFlip: number | null): Alert | null {
  if (gammaFlip == null) return null;
  const side: 'above' | 'below' = future >= gammaFlip ? 'above' : 'below';
  const prev = flipSide.get(expiration);
  flipSide.set(expiration, side);
  if (!prev || prev === side) return null;

  if (prev === 'above' && side === 'below') {
    return {
      id: `flip-cross-down-${expiration}-${hourBucket()}`,
      kind: 'flip',
      severity: 'critical',
      ts: Date.now(),
      title: `Gamma flip crossed downward · ${expiration}`,
      message: `Price ${fmt(future)} fell below gamma flip ${fmt(gammaFlip)}. Regime now negative gamma.`,
      context: { future, gammaFlip, expiration },
    };
  }
  return {
    id: `flip-cross-up-${expiration}-${hourBucket()}`,
    kind: 'flip',
    severity: 'warn',
    ts: Date.now(),
    title: `Gamma flip crossed upward · ${expiration}`,
    message: `Price ${fmt(future)} rose above gamma flip ${fmt(gammaFlip)}. Regime now positive gamma.`,
    context: { future, gammaFlip, expiration },
  };
}

/* ============== Approaching a wall ============== */

export function checkWallApproach(
  expiration: string,
  future: number,
  callWall: number | null,
  putWall: number | null,
  proximity = 0.015,
): Alert | null {
  if (callWall != null && future < callWall && (callWall - future) / future < proximity) {
    return {
      id: `near-call-wall-${expiration}-${callWall}-${halfHourBucket()}`,
      kind: 'wall',
      severity: 'warn',
      ts: Date.now(),
      title: `Spot near call wall · ${expiration}`,
      message: `Price ${fmt(future)} is ${(((callWall - future) / future) * 100).toFixed(2)}% from the call wall at ${fmt(callWall)}.`,
      context: { future, callWall, expiration },
    };
  }
  if (putWall != null && future > putWall && (future - putWall) / future < proximity) {
    return {
      id: `near-put-wall-${expiration}-${putWall}-${halfHourBucket()}`,
      kind: 'wall',
      severity: 'info',
      ts: Date.now(),
      title: `Spot near put wall · ${expiration}`,
      message: `Price ${fmt(future)} is ${(((future - putWall) / future) * 100).toFixed(2)}% from the put wall at ${fmt(putWall)}.`,
      context: { future, putWall, expiration },
    };
  }
  return null;
}

/* ============== Structural fear (skew rising across tenors) ============== */

interface TermPoint {
  expiration: string;
  tenorDays: number;
  skew25d: number | null;
}

export function checkStructuralFear(term: TermPoint[]): Alert | null {
  const valid = term.filter((t): t is TermPoint & { skew25d: number } => t.skew25d != null);
  if (valid.length < 4) return null;
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].skew25d - valid[i - 1].skew25d < 0) return null;
  }
  const first = valid[0].skew25d;
  const last = valid[valid.length - 1].skew25d;
  if (last - first < 2) return null;
  return {
    id: `structural-fear-${hourBucket()}`,
    kind: 'skew',
    severity: 'warn',
    ts: Date.now(),
    title: 'Structural skew detected',
    message: `25Δ skew rising across ${valid.length} tenors (${valid[0].expiration} ${first.toFixed(1)}% → ${valid[valid.length - 1].expiration} ${last.toFixed(1)}%).`,
    context: { first, last, term: valid },
  };
}

/* ============== Large put block ============== */

export function checkLargePutBlock(trade: FlowEvent): Alert | null {
  if (trade.tag !== 'block') return null;
  if (trade.type !== 'P' || trade.side !== 'buy') return null;
  return {
    id: `block-put-${trade.id}`,
    kind: 'block',
    severity: 'critical',
    ts: trade.ts,
    title: `Block of puts bought · ${trade.expiration} · ${fmt(trade.strike)}`,
    message: `${Math.round(trade.amount)} put contracts bought, ≈${fmt(trade.notionalUsd)} notional.`,
    context: {
      strike: trade.strike,
      amount: trade.amount,
      notionalUsd: trade.notionalUsd,
      expiration: trade.expiration,
      iv: trade.iv,
      ivDelta: trade.ivDelta,
    },
  };
}

export function checkLargeCallBlock(trade: FlowEvent): Alert | null {
  if (trade.tag !== 'block') return null;
  if (trade.type !== 'C' || trade.side !== 'buy') return null;
  return {
    id: `block-call-${trade.id}`,
    kind: 'block',
    severity: 'warn',
    ts: trade.ts,
    title: `Block of calls bought · ${trade.expiration} · ${fmt(trade.strike)}`,
    message: `${Math.round(trade.amount)} call contracts bought, ≈${fmt(trade.notionalUsd)} notional.`,
    context: {
      strike: trade.strike,
      amount: trade.amount,
      notionalUsd: trade.notionalUsd,
      expiration: trade.expiration,
      iv: trade.iv,
      ivDelta: trade.ivDelta,
    },
  };
}
