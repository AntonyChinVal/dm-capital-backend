import WebSocket from 'ws';

const WS_URL = process.env.DERIBIT_WS ?? 'wss://www.deribit.com/ws/api/v2';

export interface TickerData {
  instrument_name: string;
  state?: string;
  mark_price?: number;
  mark_iv?: number;
  underlying_price?: number;
  underlying_index?: string;
  open_interest?: number;
  greeks?: {
    delta?: number;
    gamma?: number;
    vega?: number;
    theta?: number;
    rho?: number;
  };
  index_price?: number;
  timestamp?: number;
}

type TickerHandler = (data: TickerData) => void;
type TradeHandler = (data: unknown) => void;
type VolatilityHandler = (indexName: string, data: unknown) => void;

export type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type StatusHandler = (status: WsStatus) => void;

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class DeribitWS {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private subscribed = new Set<string>();
  private tickerHandlers: TickerHandler[] = [];
  private tradeHandlers: TradeHandler[] = [];
  private volatilityHandlers: VolatilityHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private connectPromise: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private status: WsStatus = 'connecting';

  private setStatus(next: WsStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const handler of this.statusHandlers) {
      try { handler(next); } catch { /* ignore */ }
    }
  }

  currentStatus(): WsStatus {
    return this.status;
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  offStatus(handler: StatusHandler): void {
    this.statusHandlers = this.statusHandlers.filter((h) => h !== handler);
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.setStatus('connecting');
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.on('open', () => {
        console.log('[deribit-ws] connected');
        this.attempt = 0;
        this.setStatus('connected');
        resolve();
        // ask Deribit to send heartbeats so dropped connections surface fast
        this.call('public/set_heartbeat', { interval: 30 }).catch(() => {});
      });

      ws.on('message', (raw) => this.handleMessage(raw.toString()));

      ws.on('error', (err) => {
        console.error('[deribit-ws] error', err.message);
        if (this.pending.size > 0 || this.connectPromise) reject(err);
      });

      ws.on('close', (code, reason) => {
        console.warn(`[deribit-ws] closed ${code} ${reason.toString()}`);
        this.cleanup();
        this.setStatus('reconnecting');
        this.scheduleReconnect();
      });
    });
    return this.connectPromise;
  }

  /**
   * Exponential backoff with jitter (Phase 10 · B10 hardening).
   * delay = min(30s, 1000 * 2^attempt) + random(0-1000)ms
   */
  private scheduleReconnect(): void {
    this.attempt += 1;
    const baseMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(this.attempt, 5)));
    const jitter = Math.random() * 1000;
    const delay = baseMs + jitter;
    console.log(`[deribit-ws] reconnect attempt ${this.attempt} in ${Math.round(delay)}ms`);
    setTimeout(() => this.reconnect().catch(() => {}), delay);
  }

  private async reconnect() {
    const prevSubs = [...this.subscribed];
    this.subscribed.clear();
    this.connectPromise = null;
    try {
      await this.connect();
    } catch (err) {
      console.error('[deribit-ws] reconnect failed', (err as Error).message);
      this.setStatus('disconnected');
      this.scheduleReconnect();
      return;
    }
    if (prevSubs.length) {
      console.log(`[deribit-ws] re-subscribing to ${prevSubs.length} channels`);
      await this.subscribe(prevSubs);
    }
  }

  private cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error('ws closed'));
    }
    this.pending.clear();
  }

  private handleMessage(raw: string): void {
    let msg: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string };
      params?: { type?: string; channel?: string; data?: unknown };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // request/response
    if (typeof msg.id === 'number') {
      const cb = this.pending.get(msg.id);
      if (!cb) return;
      this.pending.delete(msg.id);
      if (msg.error) cb.reject(new Error(`${msg.error.code} ${msg.error.message}`));
      else cb.resolve(msg.result);
      return;
    }

    // server-initiated message
    if (msg.method === 'heartbeat' && msg.params?.type === 'test_request') {
      this.call('public/test', {}).catch(() => {});
      return;
    }

    if (msg.method === 'subscription' && msg.params?.channel) {
      const channel = msg.params.channel;
      if (channel.startsWith('ticker.')) {
        const data = msg.params.data as TickerData | undefined;
        if (data) for (const handler of this.tickerHandlers) handler(data);
        return;
      }
      if (channel.startsWith('trades.')) {
        const data = msg.params.data;
        if (!data) return;
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          for (const handler of this.tradeHandlers) handler(row);
        }
        return;
      }
      if (channel.startsWith('deribit_volatility_index.')) {
        const indexName = channel.slice('deribit_volatility_index.'.length);
        const data = msg.params.data;
        if (!data) return;
        for (const handler of this.volatilityHandlers) handler(indexName, data);
        return;
      }
    }
  }

  onTicker(handler: TickerHandler): void {
    this.tickerHandlers.push(handler);
  }

  onTrade(handler: TradeHandler): void {
    this.tradeHandlers.push(handler);
  }

  onVolatility(handler: VolatilityHandler): void {
    this.volatilityHandlers.push(handler);
  }

  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('ws not open'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async subscribe(channels: string[]): Promise<void> {
    const fresh = channels.filter((c) => !this.subscribed.has(c));
    if (!fresh.length) return;
    const BATCH = 50;
    for (let i = 0; i < fresh.length; i += BATCH) {
      const chunk = fresh.slice(i, i + BATCH);
      try {
        await this.call<string[]>('public/subscribe', { channels: chunk });
        for (const c of chunk) this.subscribed.add(c);
      } catch (err) {
        console.error(`[deribit-ws] subscribe batch failed: ${(err as Error).message}`);
      }
    }
  }

  async unsubscribe(channels: string[]): Promise<void> {
    const known = channels.filter((c) => this.subscribed.has(c));
    if (!known.length) return;
    const BATCH = 50;
    for (let i = 0; i < known.length; i += BATCH) {
      const chunk = known.slice(i, i + BATCH);
      try {
        await this.call('public/unsubscribe', { channels: chunk });
        for (const c of chunk) this.subscribed.delete(c);
      } catch (err) {
        console.error(`[deribit-ws] unsubscribe batch failed: ${(err as Error).message}`);
      }
    }
  }

  subscribedCount(): number {
    return this.subscribed.size;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
