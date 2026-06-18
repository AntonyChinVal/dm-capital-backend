export interface DeribitEnvelope<T> {
  jsonrpc: '2.0';
  id?: number;
  result?: T;
  error?: { code: number; message: string };
  usIn?: number;
  usOut?: number;
  usDiff?: number;
}

export interface IndexPrice {
  index_price: number;
  estimated_delivery_price: number;
}

export interface BookSummary {
  instrument_name: string;
  underlying_index: string;
  underlying_price: number;
  mark_price?: number;
  mark_iv?: number;
  bid_price?: number | null;
  ask_price?: number | null;
  mid_price?: number | null;
  last?: number | null;
  open_interest: number;
  volume: number;
  volume_usd?: number;
  volume_notional?: number;
  high?: number | null;
  low?: number | null;
  price_change?: number | null;
  interest_rate?: number;
  creation_timestamp?: number;
}
