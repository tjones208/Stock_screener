// Position sizing from a trade plan. Pure — used by the screener and unit tests.
import type { Levels } from "./levels.ts";
import type { ScreenerRow } from "./screen.ts";

export type SizingSettings = {
  /** Account equity in dollars. */
  account: number;
  /** Percent of the account to risk per trade (loss if the stop is hit). */
  riskPct: number;
  /** Intraday buying power as a multiple of equity (4× for pattern-day-trader margin accounts). */
  dayTradeLeverage: number;
  /** Overnight buying power multiple (2× Reg T) for swing strategies. */
  overnightLeverage: number;
  /** Cap shares at this percent of the 20-day average daily volume. */
  maxAdvPct: number;
  /** Dollars of cash collateral per wheel position (cash-secured puts). */
  wheelAllocation: number;
};

export const DEFAULT_SIZING: SizingSettings = {
  account: 120_000,
  riskPct: 1,
  dayTradeLeverage: 4,
  overnightLeverage: 2,
  maxAdvPct: 1,
  wheelAllocation: 5_000,
};

/** Merge stored/submitted values over the defaults, dropping anything non-numeric or out of range. */
export function normalizeSizing(input: Partial<Record<keyof SizingSettings, unknown>> | null | undefined): SizingSettings {
  const out = { ...DEFAULT_SIZING };
  const limits: Record<keyof SizingSettings, [number, number]> = {
    account: [100, 1e9],
    riskPct: [0.01, 100],
    dayTradeLeverage: [1, 10],
    overnightLeverage: [1, 10],
    maxAdvPct: [0.01, 100],
    wheelAllocation: [100, 1e9],
  };
  for (const k of Object.keys(limits) as (keyof SizingSettings)[]) {
    const v = Number(input?.[k]);
    const [lo, hi] = limits[k];
    if (input?.[k] !== undefined && input?.[k] !== "" && Number.isFinite(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

export type Size = {
  /** Shares for stock trades, contracts for the wheel. */
  qty: number;
  unit: "sh" | "ct";
  /** Dollars deployed (shares × entry, or cash collateral for puts). */
  position: number;
  /** Dollars lost if the stop is hit (for the wheel: loss at breakeven-to-zero is not meaningful, so 0). */
  risk: number;
  /** Dollars made if the target is hit. */
  reward: number;
  /** Which limit set the size. */
  cap: "risk" | "buying power" | "liquidity" | "allocation";
};

export function sizePosition(
  l: Levels,
  r: ScreenerRow,
  overnight: boolean,
  s: SizingSettings = DEFAULT_SIZING,
): Size | null {
  if (l.side === "Sell put") {
    if (r.put_strike == null) return null;
    const collateral = r.put_strike * 100;
    const qty = Math.floor(s.wheelAllocation / collateral);
    if (qty < 1) return null;
    // Credit collected = mid × 100 per contract; buying back at target keeps (entry − target) × 100.
    return { qty, unit: "ct", position: qty * collateral, risk: 0, reward: qty * (l.entry - l.target) * 100, cap: "allocation" };
  }

  const perShare = Math.abs(l.entry - l.stop);
  if (!(perShare > 0) || !(l.entry > 0)) return null;
  const byRisk = Math.floor((s.account * s.riskPct) / 100 / perShare);
  const bp = s.account * (overnight ? s.overnightLeverage : s.dayTradeLeverage);
  const byBp = Math.floor(bp / l.entry);
  const byLiq = r.avg_vol20 != null ? Math.floor((r.avg_vol20 * s.maxAdvPct) / 100) : Infinity;

  const qty = Math.min(byRisk, byBp, byLiq);
  if (!(qty >= 1) || !Number.isFinite(qty)) return null;
  const cap = qty === byRisk ? "risk" : qty === byBp ? "buying power" : "liquidity";
  return {
    qty,
    unit: "sh",
    position: qty * l.entry,
    risk: qty * perShare,
    reward: qty * Math.abs(l.target - l.entry),
    cap,
  };
}
