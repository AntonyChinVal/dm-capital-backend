/**
 * ATM IV via linear interpolation by strike between the two strikes
 * bracketing the forward (B7.1 in ROADMAP).
 *
 * Deribit's `mark_iv` ships in percent (e.g. 42.59 = 42.59%). Return in
 * the same format — caller divides by 100 only at the formula boundary.
 */
interface AtmIvInput {
  strike: number;
  type: 'C' | 'P';
  markIv: number;
}

export function atmIv(rows: AtmIvInput[], forward: number): number | null {
  if (!Number.isFinite(forward) || forward <= 0) return null;

  // Average call+put IV per strike. Put-call parity makes them very close
  // at ATM; averaging smooths the rare cases where one side is illiquid.
  const byStrike = new Map<number, number[]>();
  for (const r of rows) {
    if (!r.markIv || r.markIv <= 0) continue;
    if (!byStrike.has(r.strike)) byStrike.set(r.strike, []);
    byStrike.get(r.strike)!.push(r.markIv);
  }
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (!strikes.length) return null;

  const ivAt = (k: number): number => {
    const ivs = byStrike.get(k)!;
    return ivs.reduce((sum, v) => sum + v, 0) / ivs.length;
  };

  // Forward outside the strike range → return nearest extreme (don't extrapolate).
  if (forward <= strikes[0]) return ivAt(strikes[0]);
  if (forward >= strikes[strikes.length - 1]) return ivAt(strikes[strikes.length - 1]);

  // Walk strikes to find the bracket [kLo, kHi] such that kLo ≤ forward < kHi.
  let lo = 0;
  while (strikes[lo + 1] <= forward) lo++;
  const kLo = strikes[lo];
  const kHi = strikes[lo + 1];
  const ivLo = ivAt(kLo);
  const ivHi = ivAt(kHi);
  const t = (forward - kLo) / (kHi - kLo);
  return ivLo + t * (ivHi - ivLo);
}
