// Pure wheel-strategy math: OCC parsing, put filtering and ranking. No I/O.

export type Occ = { root: string; expiration: string; side: "put" | "call"; strike: number };

/** Parse an OCC option symbol, e.g. "F251121P00010500" → F, 2025-11-21, put, 10.5 */
export function parseOcc(symbol: string): Occ | null {
  const m = /^([A-Z0-9.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol);
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strike] = m;
  return {
    root,
    expiration: `20${yy}-${mm}-${dd}`,
    side: cp === "P" ? "put" : "call",
    strike: Number(strike) / 1000,
  };
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86_400_000);
}

export type WheelSettings = {
  maxCollateral: number; // strike * 100 must fit under this
  minDte: number;
  maxDte: number;
  minDelta: number; // absolute, e.g. 0.10
  maxDelta: number; // absolute, e.g. 0.35
  minOpenInterest: number;
  maxSpreadPct: number; // (ask-bid)/mid
};

export const DEFAULT_WHEEL: WheelSettings = {
  maxCollateral: 5000,
  minDte: 14,
  maxDte: 50,
  minDelta: 0.1,
  maxDelta: 0.35,
  minOpenInterest: 50,
  maxSpreadPct: 0.35,
};

export type RawPut = {
  contract: string;
  ticker: string;
  expiration: string;
  strike: number;
  underlying: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  iv: number | null;
  delta: number | null;
  theta: number | null;
  openInterest: number | null;
  volume: number | null;
};

export type ScoredPut = RawPut & {
  side: "put";
  dte: number;
  mid: number;
  spreadPct: number;
  otmPct: number;
  collateral: number;
  annualYield: number;
  score: number;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Composite rank, in the agreed priority order:
 *   1. annualized premium yield (40%)  — 60%/yr or more scores full marks
 *   2. implied volatility        (25%) — 100% IV or more scores full marks
 *   3. safety / low delta        (20%) — delta 0.10 → 1, delta 0.35 → 0
 *   4. options liquidity         (15%) — open interest (log scale) and tight spread
 */
export function scorePut(p: { annualYield: number; iv: number | null; delta: number | null; openInterest: number | null; spreadPct: number }): number {
  const yieldS = clamp01(p.annualYield / 0.6);
  const ivS = clamp01((p.iv ?? 0) / 1.0);
  const d = Math.abs(p.delta ?? 0.3);
  const safetyS = clamp01((0.35 - d) / 0.25);
  const oiS = clamp01(Math.log10(Math.max(1, p.openInterest ?? 0)) / 3); // 1000 OI → 1
  const spreadS = clamp01(1 - p.spreadPct / 0.35);
  const liqS = 0.6 * oiS + 0.4 * spreadS;
  return Math.round((0.4 * yieldS + 0.25 * ivS + 0.2 * safetyS + 0.15 * liqS) * 1000) / 10; // 0–100
}

/** Filter raw puts down to wheel-eligible ones and score them. */
export function rankPuts(puts: RawPut[], asOf: string, s: WheelSettings = DEFAULT_WHEEL): ScoredPut[] {
  const out: ScoredPut[] = [];
  for (const p of puts) {
    if (p.bid == null || p.ask == null || p.bid <= 0 || p.ask < p.bid) continue;
    const dte = daysBetween(asOf, p.expiration);
    if (dte < s.minDte || dte > s.maxDte) continue;
    const collateral = p.strike * 100;
    if (collateral > s.maxCollateral) continue;
    if (p.strike >= p.underlying) continue; // OTM puts only
    const d = p.delta == null ? null : Math.abs(p.delta);
    if (d != null && (d < s.minDelta || d > s.maxDelta)) continue;
    if ((p.openInterest ?? 0) < s.minOpenInterest) continue;
    const mid = (p.bid + p.ask) / 2;
    const spreadPct = (p.ask - p.bid) / mid;
    if (spreadPct > s.maxSpreadPct) continue;
    const annualYield = (mid / p.strike) * (365 / Math.max(1, dte));
    const otmPct = (p.underlying - p.strike) / p.underlying;
    out.push({
      ...p,
      side: "put",
      dte,
      mid,
      spreadPct,
      otmPct,
      collateral,
      annualYield,
      score: scorePut({ annualYield, iv: p.iv, delta: p.delta, openInterest: p.openInterest, spreadPct }),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
