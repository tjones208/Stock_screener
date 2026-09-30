// Momentum strategy settings (spec section 1). Every rule parameter lives here; nothing is hard-coded
// elsewhere. Stored in ss_settings under "momentum" and merged over these defaults.

export const MOM_DEFAULTS = {
  B: 20_000, // strategy buying power, changes often
  E: 120_000, // total account equity (risk cap only)
  cash_reserve_pct: 0.02,
  p_min: 1_500, // minimum position size $
  n_min: 8,
  n_max: 25,
  min_price: 10,
  min_market_cap: 2.0e9,
  min_median_dollar_vol_60d: 2.0e7,
  min_history_days: 273,
  mom_lookback: 252,
  mom_skip: 21,
  high_window: 252,
  entry_mom_pct: 70,
  entry_h52: 0.9,
  entry_max_days_since_high: 63,
  hold_mom_pct: 50,
  hold_h52: 0.8,
  hold_comprank_mult: 2, // keep if CompRank <= 2*N
  regime_sma_months: 10,
  vol_lookback: 63,
  weight_floor_mult: 0.5, // 0.5/n
  weight_cap_mult: 1.5, // 1.5/n
  atr_period: 20,
  stop_atr_mult: 3.0,
  stop_min_pct: 0.1,
  stop_max_pct: 0.2,
  disaster_stop_extra: 0.5, // disaster stop = Stop_t - 0.5*D
  max_risk_pct_of_E: 0.005,
  sector_max_names: 4,
  sector_max_pct_of_I: 0.3,
  chase_cap_pct: 0.03,
  trim_trigger_mult: 2.0,
  trim_to_mult: 1.5,
  topup_below_mult: 0.5,
  earnings_blackout_days: 2,
  lt_tax_window_days: 30, // calendar days
  wash_sale_block_days: 31, // calendar days
  alternates: 5,
  entry_retry_reset_day: 3,
  entry_max_retry_days: 5,
  min_B_stock_version: 8_000,
  fractional_shares: false,
  // Covered calls (not in the original spec): sold in your broker on positions already holding
  // 100+ shares, far out of the money (delta guidance below), expiring before the next month-end
  // rebalance and before earnings.
  covered_calls: true,
  call_delta_min: 0.15,
  call_delta_max: 0.2,
  call_min_dte: 5,
};

export type MomConfig = typeof MOM_DEFAULTS;
export type MomKey = keyof MomConfig;

/** Labels and groups for the settings form (same keys as the spec's config.yaml). */
export const MOM_FIELDS: { key: MomKey; label: string; group: string }[] = [
  { key: "B", label: "Strategy buying power B ($)", group: "Account" },
  { key: "E", label: "Total account equity E ($)", group: "Account" },
  { key: "cash_reserve_pct", label: "Cash reserve (fraction)", group: "Account" },
  { key: "p_min", label: "Minimum position ($)", group: "Account" },
  { key: "n_min", label: "Min positions", group: "Account" },
  { key: "n_max", label: "Max positions", group: "Account" },
  { key: "fractional_shares", label: "Fractional shares", group: "Account" },
  { key: "min_price", label: "Min price ($)", group: "Universe" },
  { key: "min_market_cap", label: "Min market cap ($)", group: "Universe" },
  { key: "min_median_dollar_vol_60d", label: "Min median 60-day $ volume", group: "Universe" },
  { key: "min_history_days", label: "Min history (trading days)", group: "Universe" },
  { key: "mom_lookback", label: "Momentum lookback (days)", group: "Signals" },
  { key: "mom_skip", label: "Momentum skip (days)", group: "Signals" },
  { key: "high_window", label: "High window (days)", group: "Signals" },
  { key: "entry_mom_pct", label: "Entry: min momentum percentile", group: "Signals" },
  { key: "entry_h52", label: "Entry: min H52", group: "Signals" },
  { key: "entry_max_days_since_high", label: "Entry: max days since high", group: "Signals" },
  { key: "hold_mom_pct", label: "Hold: min momentum percentile", group: "Signals" },
  { key: "hold_h52", label: "Hold: min H52", group: "Signals" },
  { key: "hold_comprank_mult", label: "Hold: CompRank ≤ this × N", group: "Signals" },
  { key: "regime_sma_months", label: "Regime SMA (months)", group: "Signals" },
  { key: "vol_lookback", label: "Volatility lookback (days)", group: "Sizing" },
  { key: "weight_floor_mult", label: "Weight floor (× 1/n)", group: "Sizing" },
  { key: "weight_cap_mult", label: "Weight cap (× 1/n)", group: "Sizing" },
  { key: "max_risk_pct_of_E", label: "Max risk per position (fraction of E)", group: "Sizing" },
  { key: "sector_max_names", label: "Max names per sector", group: "Sizing" },
  { key: "sector_max_pct_of_I", label: "Max sector $ (fraction of I)", group: "Sizing" },
  { key: "trim_trigger_mult", label: "Trim when value > × target", group: "Sizing" },
  { key: "trim_to_mult", label: "Trim back to × target", group: "Sizing" },
  { key: "topup_below_mult", label: "Top up when value < × target", group: "Sizing" },
  { key: "atr_period", label: "ATR period", group: "Stops" },
  { key: "stop_atr_mult", label: "Stop distance (× ATR)", group: "Stops" },
  { key: "stop_min_pct", label: "Stop distance min (fraction of fill)", group: "Stops" },
  { key: "stop_max_pct", label: "Stop distance max (fraction of fill)", group: "Stops" },
  { key: "disaster_stop_extra", label: "Disaster stop extra (× D)", group: "Stops" },
  { key: "chase_cap_pct", label: "Chase cap (fraction over signal close)", group: "Orders" },
  { key: "alternates", label: "Alternates", group: "Orders" },
  { key: "entry_retry_reset_day", label: "Retry day to reset S", group: "Orders" },
  { key: "entry_max_retry_days", label: "Max retry days", group: "Orders" },
  { key: "earnings_blackout_days", label: "Earnings blackout (trading days)", group: "Orders" },
  { key: "lt_tax_window_days", label: "Long-term tax window (calendar days)", group: "Tax" },
  { key: "wash_sale_block_days", label: "Wash-sale block (calendar days)", group: "Tax" },
  { key: "min_B_stock_version", label: "Min B for the stock version ($)", group: "Account" },
  { key: "covered_calls", label: "Show covered-call section", group: "Covered calls" },
  { key: "call_delta_min", label: "Suggested call delta min", group: "Covered calls" },
  { key: "call_delta_max", label: "Suggested call delta max", group: "Covered calls" },
  { key: "call_min_dte", label: "Min days to expiration", group: "Covered calls" },
];

/** Merge stored values over the defaults, keeping only well-typed, non-negative numbers. */
export function normalizeMomConfig(input: Partial<Record<string, unknown>> | null | undefined): MomConfig {
  const out: MomConfig = { ...MOM_DEFAULTS };
  for (const k of Object.keys(MOM_DEFAULTS) as MomKey[]) {
    const v = input?.[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof MOM_DEFAULTS[k] === "boolean") {
      (out as Record<MomKey, unknown>)[k] = v === true || v === "true" || v === "1" || v === "on";
    } else {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) (out as Record<MomKey, unknown>)[k] = n;
    }
  }
  return out;
}

/** Investable capital I and target position count N (spec 6.1–6.2). */
export function capitalAndSlots(c: Pick<MomConfig, "B" | "cash_reserve_pct" | "p_min" | "n_min" | "n_max">) {
  const I = c.B * (1 - c.cash_reserve_pct);
  const N = Math.min(c.n_max, Math.max(c.n_min, Math.floor(I / c.p_min)));
  return { I, N };
}
