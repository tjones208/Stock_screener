// Signal definitions for signal studies (Studies tab): breakout, rsi2, rs_leaders. Each shares the
// pullback strategy's liquidity filter (close ≥ $10, 20-day average dollar volume ≥ $20M, common
// stock) and a market filter (SPY close above its 200-day average), and enters at the next open.
// As backtests they buy every signal equal-weight (max_positions slots) and sell after hold_days.
import { isWeekEnd } from "../../../lib/momentum/calendar.ts";
import { pctRank } from "../../../lib/pullback/core.ts";
import type { Ctx, ParamField, StrategyDef } from "../engine/engine.ts";
import type { Order, Row } from "../engine/types.ts";

type Base = {
  min_price: number; min_avg_dollar_vol: number; dollar_vol_lookback: number; common_only: boolean;
  use_market_filter: boolean; market_ticker: string; market_ma: number;
  max_positions: number; hold_days: number;
};
const BASE: Base = {
  min_price: 10, min_avg_dollar_vol: 20_000_000, dollar_vol_lookback: 20, common_only: true,
  use_market_filter: true, market_ticker: "SPY", market_ma: 200,
  max_positions: 10, hold_days: 10,
};
const BASE_FIELDS: ParamField[] = [
  { key: "min_price", label: "Min price ($)", group: "Universe" },
  { key: "min_avg_dollar_vol", label: "Min average dollar volume ($)", group: "Universe" },
  { key: "dollar_vol_lookback", label: "Dollar-volume average (days)", group: "Universe" },
  { key: "common_only", label: "Common stocks only", group: "Universe" },
  { key: "use_market_filter", label: "Only signal when the market is above its average", group: "Market regime" },
  { key: "market_ticker", label: "Market ticker", group: "Market regime" },
  { key: "market_ma", label: "Market average (days)", group: "Market regime" },
  { key: "max_positions", label: "Backtest: positions (equal weight)", group: "Backtest" },
  { key: "hold_days", label: "Backtest: sell after (sessions)", group: "Backtest" },
];

/** Per-ticker history: closes, volumes and dollar volumes in ring buffers, plus Wilder RSI state. */
export class Tape {
  n = 0;
  private head = -1;
  private N: number;
  private c: Float64Array; private v: Float64Array; private dv: Float64Array;
  private rsiLen: number; private gain = 0; private loss = 0; private seen = 0;
  rsi = NaN;
  constructor(N: number, rsiLen = 2) {
    this.N = N; this.rsiLen = rsiLen;
    this.c = new Float64Array(N); this.v = new Float64Array(N); this.dv = new Float64Array(N);
  }
  private at = (a: Float64Array, k: number) => a[(this.head - k + this.N * 2) % this.N];
  close(k = 0) { return this.at(this.c, k); }
  push(r: { c: number; v: number; dv: number }) {
    if (this.n > 0) this.wilder(r.c - this.close());
    this.head = (this.head + 1) % this.N;
    this.n++;
    this.c[this.head] = r.c; this.v[this.head] = r.v; this.dv[this.head] = r.dv;
  }
  /** Wilder's RSI: the first average is the simple mean of `rsiLen` changes, then (prev × (n − 1) + x) / n. */
  private wilder(ch: number) {
    const L = this.rsiLen, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    this.seen++;
    if (this.seen <= L) { this.gain += g / L; this.loss += l / L; if (this.seen < L) return; }
    else { this.gain = (this.gain * (L - 1) + g) / L; this.loss = (this.loss * (L - 1) + l) / L; }
    this.rsi = this.loss === 0 ? (this.gain === 0 ? 50 : 100) : 100 - 100 / (1 + this.gain / this.loss);
  }
  /** Mean over k = skip … skip + len − 1 bars ago (NaN without enough history). */
  mean(a: "c" | "v" | "dv", len: number, skip = 0) {
    if (this.n < len + skip) return NaN;
    const arr = this[a];
    let s = 0;
    for (let k = skip; k < skip + len; k++) s += this.at(arr, k);
    return s / len;
  }
  maxClose(len: number) {
    if (this.n < len) return NaN;
    let m = -Infinity;
    for (let k = 0; k < len; k++) m = Math.max(m, this.at(this.c, k));
    return m;
  }
}

/** Running simple averages per ticker for a few fixed windows (O(1) a day each). */
class Sma {
  private sums: number[];
  private lens: number[];
  constructor(lens: number[]) { this.lens = lens; this.sums = lens.map(() => 0); }
  push(t: Tape) {
    const out: number[] = [];
    this.lens.forEach((L, j) => {
      this.sums[j] += t.close();
      if (t.n > L) this.sums[j] -= t.close(L);
      out.push(t.n >= L ? this.sums[j] / L : NaN);
    });
    return out;
  }
}

type Spec<P extends Base> = {
  name: string; description: string; defaults: Omit<P, keyof Base> & Partial<Base>; fields: ParamField[];
  studyHorizons?: number[];
  /** History bars and the moving-average windows the rule needs. */
  bars: (p: P) => number;
  smas: (p: P) => number[];
  /** Today's signals among the liquid names, strongest first. `ma[t]` holds this ticker's averages in `smas` order. */
  signals: (ctx: Ctx, liquid: { r: Row; t: Tape; ma: number[] }[], p: P) => string[];
};

function signalStrategy<P extends Base>(spec: Spec<P>): StrategyDef<P> {
  const defaults = { ...BASE, ...spec.defaults } as P;
  return {
    name: spec.name, description: spec.description, defaults, fields: [...spec.fields, ...BASE_FIELDS], studyHorizons: spec.studyHorizons,
    warmupDays: (p) => Math.ceil(Math.max(spec.bars(p), p.market_ma, p.dollar_vol_lookback) * 1.1) + 10,
    create(p) {
      const N = Math.max(spec.bars(p), p.market_ma, p.dollar_vol_lookback) + 2;
      const lens = [...new Set([...spec.smas(p), p.market_ma])];
      const tapes = new Map<string, { t: Tape; sma: Sma; ma: number[] }>();
      const held = new Map<string, number>(); // ticker → sessions held (backtests)
      let liquidToday: string[] = [];
      return {
        onClose(ctx) {
          for (const r of ctx.today.values()) {
            let x = tapes.get(r.ticker);
            if (!x) tapes.set(r.ticker, (x = { t: new Tape(N), sma: new Sma(lens), ma: [] }));
            x.t.push(r);
            x.ma = x.sma.push(x.t);
          }
          const liquid: { r: Row; t: Tape; ma: number[] }[] = [];
          for (const r of ctx.today.values()) {
            if (r.ticker === p.market_ticker || r.c < p.min_price) continue;
            if (p.common_only) { const type = ctx.tickers.get(r.ticker)?.type; if (type && type !== "CS") continue; }
            const x = tapes.get(r.ticker)!;
            if (!(x.t.mean("dv", p.dollar_vol_lookback) >= p.min_avg_dollar_vol)) continue;
            liquid.push({ r, t: x.t, ma: x.ma.slice(0, spec.smas(p).length) });
          }
          liquidToday = liquid.map((x) => x.r.ticker);
          if (!ctx.trading) return [];
          const orders: Order[] = [];
          for (const [t, n] of held) {
            if (ctx.portfolio.sharesOf(t) <= 0) { held.delete(t); continue; }
            held.set(t, n + 1);
            if (n + 1 >= p.hold_days) orders.push({ side: "sell", ticker: t, shares: "all", tag: "time" });
          }
          if (p.use_market_filter) {
            const m = tapes.get(p.market_ticker), mr = ctx.row(p.market_ticker);
            const ma = m?.ma[lens.indexOf(p.market_ma)];
            if (m && (!mr || !(mr.c > (ma ?? NaN)))) return orders;
          }
          const size = ctx.equity / p.max_positions;
          for (const t of spec.signals(ctx, liquid, p)) {
            if (held.has(t) || ctx.portfolio.sharesOf(t) > 0) continue;
            orders.push({ side: "buy", ticker: t, tag: "signal", shares: (price) => (held.size < p.max_positions ? Math.floor(size / price) : 0) });
          }
          return orders;
        },
        universe: () => liquidToday,
        onFill(f, ctx) {
          if (f.side === "buy") held.set(f.ticker, 0);
          else if (ctx.portfolio.sharesOf(f.ticker) <= 0) held.delete(f.ticker);
        },
      };
    },
  };
}

type Breakout = Base & { high_days: number; vol_days: number; vol_mult: number; fast_ma: number; slow_ma: number };
export const breakout = signalStrategy<Breakout>({
  name: "breakout",
  description: "Signal study: close is the highest close of the last 50 days, volume ≥ 1.5× its prior 50-day average, 50-day > 200-day average; SPY above its 200-day.",
  defaults: { high_days: 50, vol_days: 50, vol_mult: 1.5, fast_ma: 50, slow_ma: 200 },
  fields: [
    { key: "high_days", label: "Highest close of the last (days, today included)", group: "Signal" },
    { key: "vol_days", label: "Volume average (prior days)", group: "Signal" },
    { key: "vol_mult", label: "Volume ≥ × average", group: "Signal" },
    { key: "fast_ma", label: "Fast MA (days)", group: "Signal" },
    { key: "slow_ma", label: "Slow MA (days)", group: "Signal" },
  ],
  bars: (p) => Math.max(p.high_days, p.vol_days + 1, p.slow_ma, p.fast_ma),
  smas: (p) => [p.fast_ma, p.slow_ma],
  signals: (_ctx, liquid, p) => liquid
    .filter(({ r, t, ma: [f, s] }) => f > s && r.c >= t.maxClose(p.high_days) && r.v >= p.vol_mult * t.mean("v", p.vol_days, 1))
    .sort((a, b) => b.r.v / b.t.mean("v", p.vol_days, 1) - a.r.v / a.t.mean("v", p.vol_days, 1))
    .map((x) => x.r.ticker),
});

type Rsi2 = Base & { rsi_max: number; trend_ma: number };
export const rsi2 = signalStrategy<Rsi2>({
  name: "rsi2",
  description: "Signal study: 2-day RSI (Wilder) under 10 with the close above its 200-day average; SPY above its 200-day.",
  defaults: { rsi_max: 10, trend_ma: 200, hold_days: 5 },
  fields: [
    { key: "rsi_max", label: "RSI(2) under", group: "Signal" },
    { key: "trend_ma", label: "Close above MA (days)", group: "Signal" },
  ],
  studyHorizons: [3, 5, 10, 15],
  bars: (p) => p.trend_ma,
  smas: (p) => [p.trend_ma],
  signals: (_ctx, liquid, p) => liquid
    .filter(({ r, t, ma: [m] }) => t.rsi < p.rsi_max && r.c > m)
    .sort((a, b) => a.t.rsi - b.t.rsi)
    .map((x) => x.r.ticker),
});

type RsLeaders = Base & { from_days: number; skip_days: number; top_pct: number };
export const rsLeaders = signalStrategy<RsLeaders>({
  name: "rs_leaders",
  description: "Signal study: top 10% of the liquid universe by return from 126 to 21 sessions ago, on the first trading day of each week; SPY above its 200-day.",
  defaults: { from_days: 126, skip_days: 21, top_pct: 0.1, hold_days: 5 },
  fields: [
    { key: "from_days", label: "Return from (sessions ago)", group: "Signal" },
    { key: "skip_days", label: "… to (sessions ago)", group: "Signal" },
    { key: "top_pct", label: "Top fraction (0.1 = top 10%)", group: "Signal" },
  ],
  bars: (p) => p.from_days + 1,
  smas: () => [],
  signals: (ctx, liquid, p) => {
    // First trading day of the week: the previous session closed a week.
    if (ctx.i === 0 || !isWeekEnd(ctx.cal, ctx.days[ctx.i - 1])) return [];
    const scored = liquid.map((x) => ({ t: x.r.ticker, m: x.t.n > p.from_days ? x.t.close(p.skip_days) / x.t.close(p.from_days) - 1 : NaN }))
      .filter((x) => Number.isFinite(x.m));
    const sorted = scored.map((x) => x.m).sort((a, b) => a - b);
    return scored.filter((x) => pctRank(sorted, x.m) > 1 - p.top_pct).sort((a, b) => b.m - a.m).map((x) => x.t);
  },
});
