import { EventEmitter } from 'node:events';
import type { FlowEvent } from '../compute/tradeFlow.js';

const MAX_BUFFER = 200;

class TradeStream extends EventEmitter {
  private buffer: FlowEvent[] = [];

  push(ev: FlowEvent): void {
    // dedupe by trade id — Deribit sometimes resends
    if (this.buffer[0]?.id === ev.id) return;
    this.buffer.unshift(ev);
    if (this.buffer.length > MAX_BUFFER) this.buffer.length = MAX_BUFFER;
    this.emit('trade', ev);
  }

  recent(n = 50): FlowEvent[] {
    return this.buffer.slice(0, n);
  }

  size(): number {
    return this.buffer.length;
  }
}

export const tradeStream = new TradeStream();
tradeStream.setMaxListeners(50);
