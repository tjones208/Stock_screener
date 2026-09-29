// Strategy presets for the screener. Picking one prefills the filters, sort and table columns.
// All data is end-of-day, so day-trading presets build *tomorrow's* watchlist from today's close;
// entries and exits still happen intraday on a live chart.
import type { Filters } from "./screen.ts";
import type { SizingOverrides } from "./sizing.ts";

/** Market-wide state a strategy can require before it generates any signals. */
export type MarketRegime = { ticker: string; close: number | null; sma200: number | null; as_of: string | null } | null;

export type Strategy = {
  key: string;
  name: string;
  style: "Options" | "Day trade" | "Swing";
  /** What the preset looks for, in one or two sentences. */
  summary: string;
  /** How to use the list the next session. */
  playbook: string;
  filters: Filters;
  /** Column keys from the screener's column registry. */
  columns: string[];
  /** Market conditions that must hold, or the strategy shows no signals at all. */
  requires?: { benchmarkAbove200?: boolean };
  /** Strategy-specific sizing limits. These only ever tighten the user's global settings. */
  sizing?: SizingOverrides;
  /** "close" = level-based orders placed off today's bar; "next_open" = market-on-open T+1 with a gap band. */
  execution?: "close" | "next_open";
};

export const STRATEGIES: Strategy[] = [
  {
    key: "wheel",
    name: "Wheel — cash-secured puts",
    style: "Options",
    summary: "Liquid uptrending stocks under $50 with a put at delta ≤ 0.30 paying ≥ 20%/yr and no earnings in the next 30 days.",
    playbook: "Sell the listed put (or a nearby strike) and roll or take assignment, then sell covered calls. Confirm the premium in Robinhood.",
    filters: {
      close_min: "5", close_max: "50", avg_vol20_min: "1000000",
      above_sma200: "1", has_put: "1", no_earnings_30d: "1",
      put_delta_max: "0.30", put_annual_yield_min: "20", put_oi_min: "100",
      sort: "wheel_score", dir: "desc",
    },
    columns: ["close", "change_pct", "rsi14", "put", "put_annual_yield", "put_delta", "put_iv", "put_oi", "put_spread_pct", "wheel_score"],
  },
  {
    key: "vwap",
    name: "VWAP reversion",
    style: "Day trade",
    summary: "Very liquid names with enough daily range to trade (ATR 2–6%) but orderly enough that price keeps coming back to VWAP.",
    playbook: "Next session, fade moves stretched 1–2 ATR-bands from VWAP back toward it; skip names trending hard away from VWAP on news.",
    filters: {
      close_min: "10", close_max: "200", avg_vol20_min: "2000000", dollar_vol_min: "50000000",
      atr_pct_min: "2", atr_pct_max: "6",
      sort: "dollar_vol", dir: "desc",
    },
    columns: ["close", "change_pct", "vwap", "pct_from_vwap", "atr_pct", "vol_ratio", "dollar_vol", "range_pos", "rsi14"],
  },
  {
    key: "orb",
    name: "Opening range breakout — stocks in play",
    style: "Day trade",
    summary: "Stocks trading ≥ 2× normal volume with ATR ≥ 3% — the ‘in play’ names where opening-range breakouts work best.",
    playbook: "Mark the first 5- or 15-minute high/low; enter on a break with volume, stop at the other side of the range.",
    filters: {
      close_min: "5", close_max: "200", avg_vol20_min: "1000000",
      vol_ratio_min: "2", atr_pct_min: "3", atr_pct_max: "12", dollar_vol_min: "20000000",
      sort: "vol_ratio", dir: "desc",
    },
    columns: ["close", "change_pct", "gap_pct", "vol_ratio", "atr_pct", "range_pos", "dollar_vol", "nr7"],
  },
  {
    key: "gap_go",
    name: "Gap & go continuation",
    style: "Day trade",
    summary: "Gapped up ≥ 4% on ≥ 2× volume and closed in the top 30% of the day's range — strength that held into the close.",
    playbook: "Watch for a second-day move: buy a break of today's high or the premarket high; avoid if it gaps down below today's close.",
    filters: {
      close_min: "2", close_max: "100", avg_vol20_min: "500000",
      gap_pct_min: "4", vol_ratio_min: "2", range_pos_min: "70", atr_pct_max: "12",
      sort: "gap_pct", dir: "desc",
    },
    columns: ["close", "gap_pct", "change_pct", "vol_ratio", "range_pos", "atr_pct", "pct_from_high"],
  },
  {
    key: "squeeze",
    name: "NR7 volatility squeeze",
    style: "Day trade",
    summary: "Today was the narrowest range in 7 days, in an uptrend above the 50-day — compressed ranges tend to expand.",
    playbook: "Next session, trade the break of today's high (or low) with a stop inside today's range.",
    filters: {
      close_min: "5", avg_vol20_min: "1000000",
      nr7: "1", above_sma50: "1", atr_pct_min: "2",
      sort: "atr_pct", dir: "desc",
    },
    columns: ["close", "change_pct", "nr7", "inside_day", "atr_pct", "vol_ratio", "pct_from_sma50", "rsi14"],
  },
  {
    key: "momentum",
    name: "Momentum — 52-week high breakout",
    style: "Swing",
    summary: "Up ≥ 10% in 20 days, within 3% of a 52-week high, with the 50-day above the 200-day. Check the RVOL column for volume confirmation.",
    playbook: "Buy strength through the high or the first pullback to the 9/21 EMA; trail a stop under the 21 EMA.",
    filters: {
      close_min: "5", avg_vol20_min: "500000",
      near_52w_high: "1", sma50_above_sma200: "1", change_20d_min: "10",
      sort: "change_20d", dir: "desc",
    },
    columns: ["close", "change_pct", "change_20d", "pct_from_high", "vol_ratio", "rsi14", "atr_pct"],
  },
  {
    key: "pullback",
    name: "Pullback in an uptrend",
    style: "Swing",
    summary: "Strong trend (above the 200-day, 50 over 200) that has pulled back to within −3%/+2% of the 50-day with RSI cooled to 40–55.",
    playbook: "Enter on a bounce off the 50-day (e.g. a close back above the prior day's high); stop below the recent swing low.",
    filters: {
      close_min: "5", avg_vol20_min: "500000",
      above_sma200: "1", sma50_above_sma200: "1",
      pct_from_sma50_min: "-3", pct_from_sma50_max: "2", rsi14_min: "40", rsi14_max: "55",
      sort: "rsi14", dir: "asc",
    },
    columns: ["close", "change_pct", "pct_from_sma50", "rsi14", "change_5d", "pct_from_high", "atr_pct"],
  },
  {
    key: "oversold",
    name: "Oversold bounce",
    style: "Swing",
    summary:
      "Long-term uptrend (above the 200-day) that fell ≥ 5% in 5 days to Wilder RSI(14) ≤ 30, then printed a bullish reversal candle " +
      "(green close, hammer or engulfing). Only while SPY is above its 200-day; ATR ≤ 12% of price; no earnings in the next 5 trading days.",
    playbook:
      "Buy at the next open (market-on-open) only if it opens inside the valid range. Exit at the 10-day average (target), the stop, " +
      "or the close of the 5th trading day, whichever comes first. Check the news first: the earnings calendar isn't available on the free data plans.",
    filters: {
      close_min: "5", avg_vol20_min: "1000000",
      above_sma200: "1", rsi14_max: "30", change_5d_max: "-5", atr_pct_max: "12",
      bullish_reversal: "1", no_earnings_5d: "1",
      sort: "rsi14", dir: "asc",
    },
    columns: ["close", "change_pct", "reversal", "change_5d", "rsi14", "pct_from_sma10", "atr_pct", "earnings"],
    requires: { benchmarkAbove200: true },
    // 0.5% risk per trade, ≤ 15% of equity per position, ≤ 0.10% of average daily volume.
    sizing: { riskPct: 0.5, maxPositionPct: 15, maxAdvPct: 0.1 },
    execution: "next_open",
  },
];

export const STRATEGY_BY_KEY = new Map(STRATEGIES.map((s) => [s.key, s]));

/** Screener query string for a preset (includes strategy=key so columns and notes follow along). */
export function strategyQuery(s: Strategy): string {
  return new URLSearchParams({ strategy: s.key, ...s.filters }).toString();
}

/**
 * Whether a strategy may generate signals under the current market regime.
 * A required regime that can't be confirmed (benchmark missing or < 200 days of history) blocks too.
 */
export function strategyGate(s: Strategy, regime: MarketRegime): { ok: boolean; reason?: string } {
  if (!s.requires?.benchmarkAbove200) return { ok: true };
  const t = regime?.ticker ?? "SPY";
  if (!regime || regime.close == null || regime.sma200 == null) {
    return { ok: false, reason: `Market regime unknown: ${t} doesn't have 200 days of history loaded yet, so long signals are paused.` };
  }
  if (regime.close <= regime.sma200) {
    return { ok: false, reason: `${t} closed at $${regime.close.toFixed(2)}, below its 200-day average ($${regime.sma200.toFixed(2)}). Long signals are off until it recovers.` };
  }
  return { ok: true, reason: `${t} $${regime.close.toFixed(2)} is above its 200-day average ($${regime.sma200.toFixed(2)}).` };
}
