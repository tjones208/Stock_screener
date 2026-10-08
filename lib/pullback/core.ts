// Momentum pullback swing rules, shared by the backtester (backtest/src/strategies/pullback.ts) and
// the app's daily scan (lib/pullback/scan.ts), so live signals follow exactly what was tested.
// Pure: no I/O. Parameter names match the original Python Params.

export type PbParams = {
  risk_per_trade: number; max_positions: number; max_position_pct: number; max_portfolio_heat: number;
  min_price: number; min_avg_dollar_vol: number; dollar_vol_lookback: number; common_only: boolean;
  fast_ma: number; mid_ma: number; slow_ma: number;
  rs_lookback: number; rs_min_percentile: number; rs_universe: string;
  pullback_window: number; ma_touch_tolerance: number; min_down_days: number;
  swing_low_lookback: number; atr_period: number; stop_buffer_atr: number; min_stop_pct: number; max_stop_pct: number;
  reward_risk: number; exit_on_close_below_fast_ma: boolean; max_hold_days: number;
  use_market_filter: boolean; market_ticker: string;
};

export const PB_DEFAULTS: PbParams = {
  risk_per_trade: 0.0075, max_positions: 8, max_position_pct: 0.2, max_portfolio_heat: 0.045,
  min_price: 10, min_avg_dollar_vol: 20_000_000, dollar_vol_lookback: 20, common_only: true,
  fast_ma: 20, mid_ma: 50, slow_ma: 200,
  rs_lookback: 126, rs_min_percentile: 0.75, rs_universe: "liquid",
  pullback_window: 5, ma_touch_tolerance: 0.02, min_down_days: 2,
  swing_low_lookback: 10, atr_period: 14, stop_buffer_atr: 0.25, min_stop_pct: 0.02, max_stop_pct: 0.1,
  reward_risk: 2, exit_on_close_below_fast_ma: true, max_hold_days: 15,
  use_market_filter: true, market_ticker: "SPY",
};

export type PbField = { key: keyof PbParams; label: string; group: string; choices?: readonly string[]; help?: string };
export const PB_FIELDS: PbField[] = [
  { key: "risk_per_trade", label: "Risk per trade (fraction of equity)", group: "Risk & sizing" },
  { key: "max_positions", label: "Max positions", group: "Risk & sizing" },
  { key: "max_position_pct", label: "Max position (fraction of equity)", group: "Risk & sizing" },
  { key: "max_portfolio_heat", label: "Max total open risk (fraction of equity)", group: "Risk & sizing" },
  { key: "min_price", label: "Min price ($)", group: "Universe" },
  { key: "min_avg_dollar_vol", label: "Min average dollar volume ($)", group: "Universe" },
  { key: "dollar_vol_lookback", label: "Dollar-volume average (days)", group: "Universe" },
  { key: "common_only", label: "Common stocks only", group: "Universe" },
  { key: "fast_ma", label: "Fast MA (days)", group: "Trend" },
  { key: "mid_ma", label: "Mid MA (days)", group: "Trend" },
  { key: "slow_ma", label: "Slow MA (days)", group: "Trend" },
  { key: "rs_lookback", label: "Relative-strength lookback (days)", group: "Relative strength" },
  { key: "rs_min_percentile", label: "Min RS percentile (0.75 = top 25%)", group: "Relative strength" },
  { key: "rs_universe", label: "Rank RS among", group: "Relative strength", choices: ["liquid", "all"],
    help: "liquid: stocks passing the price and dollar-volume filters. all: every stock with enough history (the original Python)." },
  { key: "pullback_window", label: "Pullback window (days)", group: "Pullback" },
  { key: "ma_touch_tolerance", label: "Fast-MA touch tolerance", group: "Pullback" },
  { key: "min_down_days", label: "Min consecutive down closes", group: "Pullback" },
  { key: "swing_low_lookback", label: "Swing-low lookback (days)", group: "Stops & exits" },
  { key: "atr_period", label: "ATR period (days)", group: "Stops & exits" },
  { key: "stop_buffer_atr", label: "Stop buffer (× ATR)", group: "Stops & exits" },
  { key: "min_stop_pct", label: "Skip stops tighter than", group: "Stops & exits" },
  { key: "max_stop_pct", label: "Skip stops wider than", group: "Stops & exits" },
  { key: "reward_risk", label: "Target (R multiple)", group: "Stops & exits" },
  { key: "exit_on_close_below_fast_ma", label: "Exit on a close below the fast MA", group: "Stops & exits" },
  { key: "max_hold_days", label: "Time stop (trading days)", group: "Stops & exits" },
  { key: "use_market_filter", label: "Only buy when the market is above its slow MA", group: "Market regime" },
  { key: "market_ticker", label: "Market ticker", group: "Market regime" },
];

/** Settings JSON → parameters (unknown keys dropped, bad values fall back to the defaults). */
export function normalizePb(input: Record<string, unknown> | null | undefined): PbParams {
  const out = { ...PB_DEFAULTS } as Record<string, unknown>;
  for (const [k, dflt] of Object.entries(PB_DEFAULTS)) {
    const v = input?.[k];
    if (v == null || v === "") continue;
    if (typeof dflt === "boolean") out[k] = v === true || v === "true" || v === "on";
    else if (typeof dflt === "number") { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else out[k] = String(v);
  }
  const p = out as PbParams;
  for (const k of ["max_positions", "dollar_vol_lookback", "fast_ma", "mid_ma", "slow_ma", "rs_lookback", "pullback_window", "min_down_days", "swing_low_lookback", "atr_period", "max_hold_days"] as const) {
    p[k] = Math.max(1, Math.round(p[k]));
  }
  return p;
}

/** Bars of history a ticker needs for every rule. */
export const pbHistoryBars = (p: PbParams) =>
  Math.max(p.slow_ma, p.mid_ma, p.fast_ma, p.rs_lookback + 1, p.atr_period, p.dollar_vol_lookback, p.swing_low_lookback, p.pullback_window + 1) + 1;

export type PbBar = { c: number; h: number; l: number; dv: number };

/** Per-ticker rolling history in ring buffers, with running sums for the moving averages. */
export class Hist {
  n = 0;
  private head = -1;
  private c: Float64Array; private h: Float64Array; private l: Float64Array; private tr: Float64Array; private dv: Float64Array;
  private touched: Uint8Array; private streak: Uint16Array;
  private sums = { fast: 0, mid: 0, slow: 0, tr: 0, dv: 0 };
  maFast = NaN; maMid = NaN; maSlow = NaN; atr = NaN; avgDv = NaN;
  private p: PbParams;
  private N: number;
  constructor(p: PbParams, N: number) {
    this.p = p; this.N = N;
    this.c = new Float64Array(N); this.h = new Float64Array(N); this.l = new Float64Array(N);
    this.tr = new Float64Array(N); this.dv = new Float64Array(N);
    this.touched = new Uint8Array(N); this.streak = new Uint16Array(N);
  }
  private at = (a: ArrayLike<number>, k: number) => a[(this.head - k + this.N * 2) % this.N];
  close(k = 0) { return this.at(this.c, k); }
  high(k = 0) { return this.at(this.h, k); }

  push(r: PbBar) {
    const p = this.p, had = this.n > 0;
    const pc = had ? this.close() : NaN, ps = had ? this.at(this.streak, 0) : 0;
    this.head = (this.head + 1) % this.N;
    this.n++;
    const i = this.head;
    this.c[i] = r.c; this.h[i] = r.h; this.l[i] = r.l; this.dv[i] = r.dv;
    this.tr[i] = had ? Math.max(r.h - r.l, Math.abs(r.h - pc), Math.abs(r.l - pc)) : r.h - r.l;
    const roll = (key: keyof Hist["sums"], arr: Float64Array, len: number) => {
      this.sums[key] += arr[i];
      if (this.n > len) this.sums[key] -= this.at(arr, len);
      return this.n >= len ? this.sums[key] / len : NaN;
    };
    this.maFast = roll("fast", this.c, p.fast_ma);
    this.maMid = roll("mid", this.c, p.mid_ma);
    this.maSlow = roll("slow", this.c, p.slow_ma);
    this.atr = roll("tr", this.tr, p.atr_period);
    this.avgDv = roll("dv", this.dv, p.dollar_vol_lookback);
    this.touched[i] = r.l <= this.maFast * (1 + p.ma_touch_tolerance) ? 1 : 0; // NaN MA → false
    this.streak[i] = had && r.c < pc ? Math.min(ps + 1, 65535) : 0;
  }
  /** Return over `rs_lookback` bars. */
  mom() { return this.n > this.p.rs_lookback ? this.close() / this.close(this.p.rs_lookback) - 1 : NaN; }
  /** Pullback in the window ending yesterday: touched the fast MA, or a run of down closes. */
  pullback() {
    const w = this.p.pullback_window;
    if (this.n < w + 1) return false;
    for (let k = 1; k <= w; k++) if (this.at(this.touched, k) || this.at(this.streak, k) >= this.p.min_down_days) return true;
    return false;
  }
  confirm() { return this.n > 1 && this.close() > this.high(1); }
  /** Swing low over `swing_low_lookback` bars (today included) minus the ATR buffer. */
  stopLevel() {
    const L = this.p.swing_low_lookback;
    if (this.n < L || !Number.isFinite(this.atr)) return NaN;
    let lo = Infinity;
    for (let k = 0; k < L; k++) lo = Math.min(lo, this.at(this.l, k));
    return lo - this.p.stop_buffer_atr * this.atr;
  }
}

/** Percentile rank (pandas rank(pct=True), ties averaged) of x within sorted values. */
export function pctRank(sorted: number[], x: number) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  let lt = lo; hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; }
  return (lt + 1 + lo) / 2 / sorted.length;
}


/** The entry rules after liquidity and relative strength: trend, pullback, confirmation. Returns the stop, or null. */
export function entryStop(h: Hist, close: number, rs: number, p: PbParams): number | null {
  if (!(close > h.maMid && h.maMid > h.maSlow)) return null;
  if (rs < p.rs_min_percentile || !h.pullback() || !h.confirm()) return null;
  const stop = h.stopLevel();
  return Number.isFinite(stop) ? stop : null;
}

/** Shares for an entry at `price`: risk budget ÷ (price − stop), position cap, heat cap; 0 = skip. */
export function entryShares(o: { price: number; stop: number; equity: number; cash?: number; openHeat: number; openCount: number }, p: PbParams) {
  if (o.openCount >= p.max_positions || o.price <= o.stop) return 0;
  const rps = o.price - o.stop;
  if (rps / o.price < p.min_stop_pct || rps / o.price > p.max_stop_pct) return 0;
  const n = Math.min(Math.floor((o.equity * p.risk_per_trade) / rps), Math.floor((o.equity * p.max_position_pct) / o.price), o.cash == null ? Infinity : Math.floor(o.cash / o.price));
  if (n <= 0 || o.openHeat + n * rps > p.max_portfolio_heat * o.equity) return 0;
  return n;
}

/** Entry prices that keep the stop distance inside [min_stop_pct, max_stop_pct]. */
export const entryRange = (stop: number, p: PbParams) => ({ min: stop / (1 - p.min_stop_pct), max: stop / (1 - p.max_stop_pct) });
