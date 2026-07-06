import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Shared secret. When unset, the API stays open (local dev). */
export const ACCESS_KEY = process.env.ACCESS_KEY?.trim() || null;

export function isAuthRequired(): boolean {
  return ACCESS_KEY != null && ACCESS_KEY.length > 0;
}

function readAccessKey(req: Request): string | null {
  const header = req.header('x-access-key')?.trim();
  if (header) return header;

  const auth = req.header('authorization')?.trim();
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null;
  }

  const query = req.query.access_key;
  if (typeof query === 'string' && query.trim()) return query.trim();

  return null;
}

function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireAccessKey(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthRequired()) {
    next();
    return;
  }

  const provided = readAccessKey(req);
  if (provided && keysMatch(provided, ACCESS_KEY!)) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}
