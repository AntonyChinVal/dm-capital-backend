const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export interface ParsedOption {
  instrument: string;
  underlying: string;
  expiration: string;
  expirationTimestamp: number;
  strike: number;
  type: 'C' | 'P';
}

const RE = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-(C|P)$/;

export function parseInstrument(name: string): ParsedOption | null {
  const m = RE.exec(name);
  if (!m) return null;
  const [, underlying, dayStr, monStr, yyStr, strikeStr, type] = m;
  const month = MONTHS[monStr];
  if (month === undefined) return null;
  const day = Number(dayStr);
  const year = 2000 + Number(yyStr);
  const ts = Date.UTC(year, month, day, 8, 0, 0);
  return {
    instrument: name,
    underlying,
    expiration: `${dayStr}${monStr}${yyStr}`,
    expirationTimestamp: ts,
    strike: Number(strikeStr),
    type: type as 'C' | 'P',
  };
}
