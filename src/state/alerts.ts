import { EventEmitter } from 'node:events';
import type { Alert } from '../compute/signals.js';

const MAX_BUFFER = 100;
const DEFAULT_DEDUPE_MS = 30 * 60 * 1000;

class AlertStream extends EventEmitter {
  private buffer: Alert[] = [];
  private lastEmittedAt = new Map<string, number>();

  push(alert: Alert | null, dedupeMs = DEFAULT_DEDUPE_MS): boolean {
    if (!alert) return false;
    const prev = this.lastEmittedAt.get(alert.id);
    if (prev != null && Date.now() - prev < dedupeMs) return false;
    this.lastEmittedAt.set(alert.id, Date.now());
    this.buffer.unshift(alert);
    if (this.buffer.length > MAX_BUFFER) this.buffer.length = MAX_BUFFER;
    this.emit('alert', alert);
    return true;
  }

  recent(n = 50): Alert[] {
    return this.buffer.slice(0, n);
  }

  size(): number {
    return this.buffer.length;
  }
}

export const alertStream = new AlertStream();
alertStream.setMaxListeners(50);
