import { getGreeks } from '../state/greeks.js';
import { parseInstrument } from './parseInstrument.js';

export interface DeribitTrade {
  trade_id: string;
  trade_seq?: number;
  timestamp: number;
  instrument_name: string;
  price: number;
  amount: number;
  direction: 'buy' | 'sell';
  iv?: number;
  mark_price?: number;
  index_price?: number;
  block_trade_id?: string;
  liquidation?: string;
}

export type FlowTag = 'block' | 'large';

export interface FlowEvent {
  id: string;
  ts: number;
  instrument: string;
  strike: number;
  expiration: string;
  type: 'C' | 'P';
  side: 'buy' | 'sell';
  tag: FlowTag;
  amount: number;
  notionalUsd: number;
  signedNotional: number;   // Phase 8: directional-sentiment sign × notionalUsd
  delta: number | null;
  deltaFlowUsd: number | null; // Phase B: raw aggressor sign × signed delta × amount × spot
  vega: number | null;
  vegaFlowUsd: number | null;  // Phase D: aggressor sign × vega × amount (USD per 1 IV point)
  premium: number;
  iv: number | null;
  priorIv: number | null;
  ivDelta: number | null;
  blockTradeId?: string;
  interp: string;
}

/**
 * Sign convention for NetFlow — Hernán Q8 confirmed (2026-06-17).
 * Encodes "directional sentiment" — buying a put is bearish even though
 * mechanically it is a buy order. **Irreversible once persisted to DB**;
 * do not change without a historical re-tag migration.
 */
export const FLOW_SIGN: Record<string, 1 | -1> = {
  'C/buy':  +1,  // bullish: opens upside
  'P/sell': +1,  // bullish: closes protection
  'P/buy':  -1,  // bearish: buys protection
  'C/sell': -1,  // bearish: caps upside
};

const LARGE_BTC = Number(process.env.FLOW_LARGE_BTC ?? 25);

/**
 * Parse a raw Deribit trade into a structured FlowEvent. **No threshold
 * filter inside** — the consumer (visual stream / aggregator) applies its
 * own minimum size. Returns null only when the instrument can't be parsed
 * or amount is non-positive.
 */
export function classifyTrade(raw: DeribitTrade): FlowEvent | null {
  const parsed = parseInstrument(raw.instrument_name);
  if (!parsed) return null;
  if (!raw.amount || raw.amount <= 0) return null;

  const isBlock = !!raw.block_trade_id;
  const tag: FlowTag = isBlock || raw.amount >= LARGE_BTC ? (isBlock ? 'block' : 'large') : 'large';

  const sign = FLOW_SIGN[`${parsed.type}/${raw.direction}`] ?? 0;
  const index = raw.index_price ?? 0;
  const notionalUsd = raw.amount * index;
  const signedNotional = sign * notionalUsd;

  const prior = getGreeks(raw.instrument_name);
  const delta = prior?.delta;
  const vega = prior?.vega;
  const aggressorSign = raw.direction === 'buy' ? 1 : -1;
  const deltaFlowUsd =
    delta != null && Number.isFinite(delta) && index > 0
      ? aggressorSign * delta * raw.amount * index
      : null;
  // Deribit ticker vega is already USD per 1 IV point per contract — no × spot.
  const vegaFlowUsd =
    vega != null && Number.isFinite(vega)
      ? aggressorSign * vega * raw.amount
      : null;
  const priorIv = prior?.markIv ?? null;
  const iv = raw.iv ?? null;
  const ivDelta = iv != null && priorIv != null ? iv - priorIv : null;

  return {
    id: raw.trade_id,
    ts: raw.timestamp,
    instrument: raw.instrument_name,
    strike: parsed.strike,
    expiration: parsed.expiration,
    type: parsed.type,
    side: raw.direction,
    tag,
    amount: raw.amount,
    notionalUsd,
    signedNotional,
    delta: delta != null && Number.isFinite(delta) ? delta : null,
    deltaFlowUsd,
    vega: vega != null && Number.isFinite(vega) ? vega : null,
    vegaFlowUsd,
    premium: raw.price,
    iv,
    priorIv,
    ivDelta,
    blockTradeId: raw.block_trade_id,
    interp: interpret(parsed.type, raw.direction, tag),
  };
}

/**
 * Trade interpretation — descriptive only (read-only product lock).
 * Observes what happened in the tape; never predicts or assigns intent.
 */
function interpret(type: 'C' | 'P', side: 'buy' | 'sell', tag: FlowTag): string {
  const kind = type === 'C' ? 'calls' : 'puts';
  const verb = side === 'buy' ? 'bought' : 'sold';
  const tagPrefix = tag === 'block' ? 'Block of' : 'Lot of';
  return `${tagPrefix} ${kind} ${verb}`;
}
