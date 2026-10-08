// Momentum pullback swing: buy a pullback in a strong uptrend once price turns back up, with a
// swing-low stop, a fixed-R target, a close-under-the-fast-MA exit and a time stop. Ported from the
// Python spec (Params dataclass → defaults below, same names). Signals on the close, entries at the
// next open, stop and target worked through each session (stop first when both trade).
//
// Differences from the Python: by default the relative-strength percentile ranks only stocks that
// pass the price and dollar-volume filters (rs_universe "all" ranks every ticker, as the Python does); dollar volume is the unadjusted
// close × volume; prices are split-adjusted with dividends paid as cash (not dividend-adjusted);
// `common_only` keeps ETFs and other non-common shares out; starting capital, slippage and
// commission are the run's settings, not strategy parameters.
import type { StrategyDef } from "../engine/engine.ts";
import type { Portfolio } from "../engine/portfolio.ts";
import type { Order, Row } from "../engine/types.ts";

type P = {
  risk_per_trade: number; max_positions: number; max_position_pct: number; max_portfolio_heat: number;
  min_price: number; min_avg_dollar_vol: number; dollar_vol_lookback: number; common_only: boolean;
  fast_ma: number; mid_ma: number; slow_ma: number;
  rs_lookback: number; rs_min_percentile: number; rs_universe: string;
  pullback_window: number; ma_touch_tolerance: number; min_down_days: number;
  swing_low_lookback: number; atr_period: number; stop_buffer_atr: number; min_stop_pct: number; max_stop_pct: number;
  reward_risk: number; exit_on_close_below_fast_ma: boolean; max_hold_days: number;
  use_market_filter: boolean; market_ticker: string;
};

/** Per-ticker rolling history in ring buffers, with running sums for the moving averages. */
class Hist {
  n = 0;
  private head = -1;
  private c: Float64Array; private h: Float64Array; private l: Float64Array; private tr: Float64Array; private dv: Float64Array;
  private touched: Uint8Array; private streak: Uint16Array;
  private sums = { fast: 0, mid: 0, slow: 0, tr: 0, dv: 0 };
  maFast = NaN; maMid = NaN; maSlow = NaN; atr = NaN; avgDv = NaN;
  private p: P;
  private N: number;
  constructor(p: P, N: number) {
    this.p = p; this.N = N;
    this.c = new Float64Array(N); this.h = new Float64Array(N); this.l = new Float64Array(N);
    this.tr = new Float64Array(N); this.dv = new Float64Array(N);
    this.touched = new Uint8Array(N); this.streak = new Uint16Array(N);
  }
  private at = (a: ArrayLike<number>, k: number) => a[(this.head - k + this.N * 2) % this.N];
  close(k = 0) { return this.at(this.c, k); }
  high(k = 0) { return this.at(this.h, k); }

  push(r: Row) {
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
function pctRank(sorted: number[], x: number) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  let lt = lo; hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; }
  return (lt + 1 + lo) / 2 / sorted.length;
}

type Pos = { shares: number; entry: number; stop: number; rps: number; target: number; bars: number };

export const pullback: StrategyDef<P> = {
  name: "pullback",
  description: "Momentum pullback swing: strong uptrend + top-RS stock pulls back, then closes above the prior high. Swing-low stop, 2R target, 20MA and 15-day exits, 0.75% risk per trade.",
  defaults: {
    risk_per_trade: 0.0075, max_positions: 8, max_position_pct: 0.2, max_portfolio_heat: 0.045,
    min_price: 10, min_avg_dollar_vol: 20_000_000, dollar_vol_lookback: 20, common_only: true,
    fast_ma: 20, mid_ma: 50, slow_ma: 200,
    rs_lookback: 126, rs_min_percentile: 0.75, rs_universe: "liquid",
    pullback_window: 5, ma_touch_tolerance: 0.02, min_down_days: 2,
    swing_low_lookback: 10, atr_period: 14, stop_buffer_atr: 0.25, min_stop_pct: 0.02, max_stop_pct: 0.1,
    reward_risk: 2, exit_on_close_below_fast_ma: true, max_hold_days: 15,
    use_market_filter: true, market_ticker: "SPY",
  },
  fields: [
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
  ],
  // Enough bars for the longest lookback, plus a margin for tickers with gaps.
  warmupDays: (p) => Math.ceil(Math.max(p.slow_ma, p.rs_lookback + 1, p.mid_ma) * 1.1) + 10,
  create(p) {
    const N = Math.max(p.slow_ma, p.mid_ma, p.fast_ma, p.rs_lookback + 1, p.atr_period, p.dollar_vol_lookback, p.swing_low_lookback, p.pullback_window + 1) + 1;
    const hist = new Map<string, Hist>();
    const pos = new Map<string, Pos>();
    const stopFor = new Map<string, number>(); // ticker → stop level from the signal day
    let eqPrev = 0;
    let marketSeen = false;
    let pf: Portfolio | null = null;
    const heat = () => [...pos.values()].reduce((a, x) => a + x.shares * x.rps, 0);

    return {
      onClose(ctx) {
        pf = ctx.portfolio;
        for (const r of ctx.today.values()) {
          let h = hist.get(r.ticker);
          if (!h) hist.set(r.ticker, (h = new Hist(p, N)));
          h.push(r);
        }
        eqPrev = ctx.equity;
        if (!ctx.trading) return [];
        const orders: Order[] = [];

        // Exits: flag next-open exits, otherwise keep the stop and target working.
        for (const [t, x] of pos) {
          if (ctx.portfolio.sharesOf(t) <= 0) { pos.delete(t); continue; }
          x.bars++;
          const r = ctx.row(t), h = hist.get(t);
          if (p.exit_on_close_below_fast_ma && r && h && r.c < h.maFast) orders.push({ side: "sell", ticker: t, shares: "all", tag: "close_below_ma" });
          else if (x.bars >= p.max_hold_days) orders.push({ side: "sell", ticker: t, shares: "all", tag: "time_stop" });
          else orders.push({ side: "sell", ticker: t, shares: "all", stop: x.stop, target: x.target });
        }

        // Market regime.
        if (p.use_market_filter) {
          const m = hist.get(p.market_ticker);
          if (m) marketSeen = true;
          if (marketSeen) {
            const mr = ctx.row(p.market_ticker);
            if (!mr || !m || !(mr.c > m.maSlow)) return orders;
          }
        }

        // Liquid universe → relative-strength percentile → entry signals.
        type Cand = { r: Row; h: Hist; mom: number };
        const liquid: Cand[] = [], ranked: number[] = [];
        for (const r of ctx.today.values()) {
          if (r.ticker === p.market_ticker) continue;
          if (p.common_only) { const type = ctx.tickers.get(r.ticker)?.type; if (type && type !== "CS") continue; }
          const h = hist.get(r.ticker)!, mom = h.mom();
          if (!Number.isFinite(mom)) continue;
          const ok = r.c >= p.min_price && h.avgDv >= p.min_avg_dollar_vol;
          if (ok) liquid.push({ r, h, mom });
          if (ok || p.rs_universe === "all") ranked.push(mom);
        }
        const sorted = ranked.sort((a, b) => a - b);
        const signals: { t: string; rs: number; stop: number }[] = [];
        for (const { r, h, mom } of liquid) {
          if (pos.has(r.ticker) || ctx.portfolio.sharesOf(r.ticker) > 0) continue;
          if (!(r.c > h.maMid && h.maMid > h.maSlow)) continue;
          const rs = pctRank(sorted, mom);
          if (rs < p.rs_min_percentile || !h.pullback() || !h.confirm()) continue;
          const stop = h.stopLevel();
          if (Number.isFinite(stop)) signals.push({ t: r.ticker, rs, stop });
        }
        signals.sort((a, b) => b.rs - a.rs);
        stopFor.clear();
        for (const s of signals) {
          stopFor.set(s.t, s.stop);
          orders.push({
            side: "buy", ticker: s.t, tag: "entry",
            // Sized at the real fill: risk budget ÷ (fill − stop), position cap, cash, heat cap.
            shares: (price) => {
              if (pos.size >= p.max_positions || price <= s.stop) return 0;
              const rps = price - s.stop;
              if (rps / price < p.min_stop_pct || rps / price > p.max_stop_pct) return 0;
              const n = Math.min(Math.floor((eqPrev * p.risk_per_trade) / rps), Math.floor((eqPrev * p.max_position_pct) / price), Math.floor((pf?.cash ?? 0) / price));
              if (n <= 0 || heat() + n * rps > p.max_portfolio_heat * eqPrev) return 0;
              return n;
            },
            exits: (price) => ({ stop: s.stop, target: price + p.reward_risk * (price - s.stop) }),
          });
        }
        return orders;
      },
      onFill(f, ctx) {
        if (f.side === "buy") {
          const stop = stopFor.get(f.ticker)!;
          const rps = f.price - stop;
          pos.set(f.ticker, { shares: f.shares, entry: f.price, stop, rps, target: f.price + p.reward_risk * rps, bars: 0 });
        } else if (ctx.portfolio.sharesOf(f.ticker) <= 0) pos.delete(f.ticker);
      },
    };
  },
};
