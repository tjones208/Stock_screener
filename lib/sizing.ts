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
  /** Most dollars to put into any one stock position. 0 = no cap beyond buying power. */
  maxPosition: number;
  /** Most of account equity (%) in any one stock position. 0 = no cap. */
  maxPositionPct: number;
  /** Dollars of cash collateral per wheel position (cash-secured puts). */
  wheelAllocation: number;
};

export const DEFAULT_SIZING: SizingSettings = {
  account: 120_000,
  riskPct: 1,
  dayTradeLeverage: 4,
  overnightLeverage: 2,
  maxAdvPct: 1,
  maxPosition: 0,
  maxPositionPct: 0,
  wheelAllocation: 5_000,
};

/**
 * Strategy-level limits (e.g. oversold bounce: 0.5% risk, 15% of equity, 0.10% of ADV).
 * They can only tighten the user's settings: the smaller value always wins.
 */
export type SizingOverrides = Partial<Pick<SizingSettings, "riskPct" | "maxAdvPct" | "maxPositionPct">>;

export function applyOverrides(s: SizingSettings, o: SizingOverrides | undefined): SizingSettings {
  if (!o) return s;
  const tighter = (user: number, strat: number | undefined, zeroMeansOff = false) => {
    if (strat == null) return user;
    if (zeroMeansOff && user === 0) return strat;
    return Math.min(user, strat);
  };
  return {
    ...s,
    riskPct: tighter(s.riskPct, o.riskPct),
    maxAdvPct: tighter(s.maxAdvPct, o.maxAdvPct),
    maxPositionPct: tighter(s.maxPositionPct, o.maxPositionPct, true),
  };
}

/** Merge stored/submitted values over the defaults, dropping anything non-numeric or out of range. */
export function normalizeSizing(input: Partial<Record<keyof SizingSettings, unknown>> | null | undefined): SizingSettings {
  const out = { ...DEFAULT_SIZING };
  const limits: Record<keyof SizingSettings, [number, number]> = {
    account: [100, 1e9],
    riskPct: [0.01, 100],
    dayTradeLeverage: [1, 10],
    overnightLeverage: [1, 10],
    maxAdvPct: [0.01, 100],
    maxPosition: [0, 1e9],
    maxPositionPct: [0, 100],
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
  cap: "risk" | "buying power" | "max position" | "liquidity" | "allocation";
  /** Settings actually used (after strategy overrides), for display. */
  used?: SizingSettings;
};

export function sizePosition(
  l: Levels,
  r: ScreenerRow,
  overnight: boolean,
  settings: SizingSettings = DEFAULT_SIZING,
  overrides?: SizingOverrides,
): Size | null {
  const s = applyOverrides(settings, overrides);
  if (l.side === "Sell put") {
    if (r.put_strike == null) return null;
    const collateral = r.put_strike * 100;
    const qty = Math.floor(s.wheelAllocation / collateral);
    if (qty < 1) return null;
    // Credit collected = mid × 100 per contract; buying back at target keeps (entry − target) × 100.
    return { qty, unit: "ct", position: qty * collateral, risk: 0, reward: qty * (l.entry - l.target) * 100, cap: "allocation" };
  }

  // Next-open plans size off the worst allowed fill (top of the open range) and stop-limit plans off
  // the limit price, so a fill anywhere in the allowed range can't push the loss past the budget.
  // Level-based plans use entry − stop.
  const fill = l.limit ?? l.openRange?.high ?? l.entry;
  const perShare = l.sizingRisk ?? Math.abs(l.entry - l.stop);
  if (!(perShare > 0) || !(fill > 0)) return null;
  const byRisk = Math.floor((s.account * s.riskPct) / 100 / perShare);
  const bp = s.account * (overnight ? s.overnightLeverage : s.dayTradeLeverage);
  const byBp = Math.floor(bp / fill);
  const capDollars = Math.min(
    s.maxPosition > 0 ? s.maxPosition : Infinity,
    s.maxPositionPct > 0 ? (s.account * s.maxPositionPct) / 100 : Infinity,
  );
  const byMax = Number.isFinite(capDollars) ? Math.floor(capDollars / fill) : Infinity;
  const byLiq = r.avg_vol20 != null ? Math.floor((r.avg_vol20 * s.maxAdvPct) / 100) : Infinity;

  const qty = Math.min(byRisk, byBp, byMax, byLiq);
  if (!(qty >= 1) || !Number.isFinite(qty)) return null;
  const cap = qty === byRisk ? "risk" : qty === byMax ? "max position" : qty === byBp ? "buying power" : "liquidity";
  return {
    qty,
    unit: "sh",
    position: qty * fill,
    risk: qty * perShare,
    // Reward at the reference entry (same basis as the R:R column); only the scaled-out part for T1.
    reward: Math.floor((qty * (l.scaleOutPct ?? 100)) / 100) * Math.abs(l.target - l.entry),
    cap,
    used: s,
  };
}
