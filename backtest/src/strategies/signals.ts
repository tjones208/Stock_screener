// Signal definitions for signal studies (Studies tab) and backtests: breakout, rsi2, rsi2_deep,
// rs_leaders (simple: every signal equal-weight, sold after hold_days) and rs_rsi2 (risk-sized with
// an ATR stop and a time exit). All share the pullback strategy's liquidity filter (close ≥ $10,
// 20-day average dollar volume ≥ $20M, common stock) and a market filter (SPY close above its
// 200-day average), and enter at the next open. A signal study counts every buy a strategy asks
// for with an empty portfolio, so the study and the backtest use the same entry rule.
import { isWeekEnd } from "../../../lib/momentum/calendar.ts";
import { pctRank } from "../../../lib/pullback/core.ts";
import { momSector } from "../../../lib/momentum/sector-key.ts";
import type { Ctx, ParamField, StrategyDef } from "../engine/engine.ts";
import type { Order, Row } from "../engine/types.ts";

type Filters = {
  min_price: number; min_avg_dollar_vol: number; dollar_vol_lookback: number; common_only: boolean;
  use_market_filter: boolean; market_ticker: string; market_ma: number;
};
const FILTERS: Filters = {
  min_price: 10, min_avg_dollar_vol: 20_000_000, dollar_vol_lookback: 20, common_only: true,
  use_market_filter: true, market_ticker: "SPY", market_ma: 200,
};
const FILTER_FIELDS: ParamField[] = [
  { key: "min_price", label: "Min price ($)", group: "Universe" },
  { key: "min_avg_dollar_vol", label: "Min average dollar volume ($)", group: "Universe" },
  { key: "dollar_vol_lookback", label: "Dollar-volume average (days)", group: "Universe" },
  { key: "common_only", label: "Common stocks only", group: "Universe" },
  { key: "use_market_filter", label: "Only signal when the market is above its average", group: "Market regime" },
  { key: "market_ticker", label: "Market ticker", group: "Market regime" },
  { key: "market_ma", label: "Market average (days)", group: "Market regime" },
];
type Base = Filters & { max_positions: number; hold_days: number };
const BASE: Base = { ...FILTERS, max_positions: 10, hold_days: 10 };
const BASE_FIELDS: ParamField[] = [
  ...FILTER_FIELDS,
  { key: "max_positions", label: "Backtest: positions (equal weight)", group: "Backtest" },
  { key: "hold_days", label: "Backtest: sell after (sessions)", group: "Backtest" },
];

/** Per-ticker history: closes, volumes, dollar volumes and true ranges in ring buffers, plus Wilder RSI state. */
export class Tape {
  n = 0;
  private head = -1;
  private N: number;
  private c: Float64Array; private v: Float64Array; private dv: Float64Array; private tr: Float64Array;
  private rsiLen: number; private gain = 0; private loss = 0; private seen = 0;
  rsi = NaN;
  constructor(N: number, rsiLen = 2) {
    this.N = N; this.rsiLen = rsiLen;
    this.c = new Float64Array(N); this.v = new Float64Array(N); this.dv = new Float64Array(N); this.tr = new Float64Array(N);
  }
  private at = (a: Float64Array, k: number) => a[(this.head - k + this.N * 2) % this.N];
  close(k = 0) { return this.at(this.c, k); }
  push(r: { c: number; v: number; dv: number; h?: number; l?: number }) {
    const pc = this.n > 0 ? this.close() : NaN;
    if (this.n > 0) this.wilder(r.c - pc);
    const h = r.h ?? r.c, l = r.l ?? r.c;
    this.head = (this.head + 1) % this.N;
    this.n++;
    this.c[this.head] = r.c; this.v[this.head] = r.v; this.dv[this.head] = r.dv;
    this.tr[this.head] = Number.isFinite(pc) ? Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)) : h - l;
  }
  /** Simple average of the true range over `len` bars (as in the pullback rules). */
  atr(len: number) { return this.mean("tr", len); }
  /** Wilder's RSI: the first average is the simple mean of `rsiLen` changes, then (prev × (n − 1) + x) / n. */
  private wilder(ch: number) {
    const L = this.rsiLen, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    this.seen++;
    if (this.seen <= L) { this.gain += g / L; this.loss += l / L; if (this.seen < L) return; }
    else { this.gain = (this.gain * (L - 1) + g) / L; this.loss = (this.loss * (L - 1) + l) / L; }
    this.rsi = this.loss === 0 ? (this.gain === 0 ? 50 : 100) : 100 - 100 / (1 + this.gain / this.loss);
  }
  /** Mean over k = skip … skip + len − 1 bars ago (NaN without enough history). */
  mean(a: "c" | "v" | "dv" | "tr", len: number, skip = 0) {
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

type Liquid = { r: Row; t: Tape; ma: number[] };
type Spec<P extends Filters> = {
  name: string; description: string; defaults: Partial<P>; fields: ParamField[];
  studyHorizons?: number[];
  /** History bars and the moving-average windows the rule needs. */
  bars: (p: P) => number;
  smas: (p: P) => number[];
  /** Today's signals among the liquid names, in the order to buy them. `ma` holds the ticker's averages in `smas` order. */
  signals: (ctx: Ctx, liquid: Liquid[], p: P) => string[];
  /** Narrow the day's universe after the liquidity filter (e.g. a fixed ETF list, or the top N by dollar volume). */
  restrict?: (ctx: Ctx, liquid: Liquid[], p: P) => Liquid[];
};

/** Per-ticker histories, today's liquid universe and the market filter, shared by both executors. */
function scanner<P extends Filters>(spec: Spec<P>, p: P, extraBars = 0) {
  const N = Math.max(spec.bars(p), p.market_ma, p.dollar_vol_lookback, extraBars) + 2;
  const lens = [...new Set([...spec.smas(p), p.market_ma])];
  const nSma = spec.smas(p).length;
  const tapes = new Map<string, { t: Tape; sma: Sma; ma: number[] }>();
  let liquidToday: string[] = [];
  return {
    tapes,
    universe: () => liquidToday,
    /** Feed today's bars; returns the liquid names and whether the market filter allows entries. */
    update(ctx: Ctx) {
      for (const r of ctx.today.values()) {
        let x = tapes.get(r.ticker);
        if (!x) tapes.set(r.ticker, (x = { t: new Tape(N), sma: new Sma(lens), ma: [] }));
        x.t.push(r);
        x.ma = x.sma.push(x.t);
      }
      const liquid: Liquid[] = [];
      for (const r of ctx.today.values()) {
        if ((p.use_market_filter && r.ticker === p.market_ticker) || r.c < p.min_price) continue;
        if (p.common_only) { const type = ctx.tickers.get(r.ticker)?.type; if (type && type !== "CS") continue; }
        const x = tapes.get(r.ticker)!;
        if (!(x.t.mean("dv", p.dollar_vol_lookback) >= p.min_avg_dollar_vol)) continue;
        liquid.push({ r, t: x.t, ma: x.ma.slice(0, nSma) });
      }
      if (spec.restrict) { const kept = spec.restrict(ctx, liquid, p); liquid.length = 0; liquid.push(...kept); }
      liquidToday = liquid.map((x) => x.r.ticker);
      let riskOn = true;
      if (p.use_market_filter) {
        const m = tapes.get(p.market_ticker), mr = ctx.row(p.market_ticker);
        const ma = m?.ma[lens.indexOf(p.market_ma)];
        if (m && (!mr || !(mr.c > (ma ?? NaN)))) riskOn = false;
      }
      return { liquid, riskOn };
    },
  };
}

const warmupOf = <P extends Filters>(spec: Spec<P>, extra: (p: P) => number = () => 0) =>
  (p: P) => Math.ceil(Math.max(spec.bars(p), p.market_ma, p.dollar_vol_lookback, extra(p)) * 1.1) + 10;

/** Simple executor: buy every signal equal-weight in `max_positions` slots, sell after `hold_days`. */
function signalStrategy<P extends Base>(spec: Spec<P>): StrategyDef<P> {
  const defaults = { ...BASE, ...spec.defaults } as P;
  return {
    name: spec.name, description: spec.description, defaults, fields: [...spec.fields, ...BASE_FIELDS], studyHorizons: spec.studyHorizons,
    warmupDays: warmupOf(spec),
    create(p) {
      const sc = scanner(spec, p);
      const held = new Map<string, number>(); // ticker → sessions held
      return {
        onClose(ctx) {
          const { liquid, riskOn } = sc.update(ctx);
          if (!ctx.trading) return [];
          const orders: Order[] = [];
          for (const [t, n] of held) {
            if (ctx.portfolio.sharesOf(t) <= 0) { held.delete(t); continue; }
            held.set(t, n + 1);
            if (n + 1 >= p.hold_days) orders.push({ side: "sell", ticker: t, shares: "all", tag: "time" });
          }
          if (!riskOn) return orders;
          const size = ctx.equity / p.max_positions;
          for (const t of spec.signals(ctx, liquid, p)) {
            if (held.has(t) || ctx.portfolio.sharesOf(t) > 0) continue;
            orders.push({ side: "buy", ticker: t, tag: "signal", shares: (price) => (held.size < p.max_positions ? Math.floor(size / price) : 0) });
          }
          return orders;
        },
        universe: sc.universe,
        onFill(f, ctx) {
          if (f.side === "buy") held.set(f.ticker, 0);
          else if (ctx.portfolio.sharesOf(f.ticker) <= 0) held.delete(f.ticker);
        },
      };
    },
  };
}

type Risk = Filters & {
  max_hold_days: number; stop_atr: number | null; atr_period: number; reward_risk: number | null; disaster_stop_pct: number | null;
  max_atr_pct: number | null; max_per_sector: number | null;
  /** With more signals than slots: "rs" (signal order), "rsi2" or "random" (seeded). */
  rank_by: string; seed: number;
  sizing: string; risk_per_trade: number; max_position_pct: number; max_positions: number; max_portfolio_heat: number;
};
const RISK: Risk = {
  ...FILTERS, max_hold_days: 20, stop_atr: 3, atr_period: 14, reward_risk: null, disaster_stop_pct: null,
  max_atr_pct: null, max_per_sector: null, rank_by: "rs", seed: 1, sizing: "risk", risk_per_trade: 0.0075, max_position_pct: 0.2, max_positions: 8, max_portfolio_heat: 0.045,
};
const RISK_FIELDS: ParamField[] = [
  ...FILTER_FIELDS,
  { key: "max_hold_days", label: "Time exit after (sessions)", group: "Exits" },
  { key: "stop_atr", label: "Stop: entry − × ATR (null = no stop)", group: "Exits", help: "Without a stop, positions are still sized as if the stop were 3 × ATR away." },
  { key: "atr_period", label: "ATR period (days)", group: "Exits" },
  { key: "reward_risk", label: "Target: R multiple of the stop distance (null = none)", group: "Exits" },
  { key: "disaster_stop_pct", label: "Disaster stop: close this far under entry (null = none)", group: "Exits",
    help: "e.g. 0.20: a close 20% or more below the entry sells at the next open." },
  { key: "max_atr_pct", label: "Skip signals with ATR ÷ close over (null = off)", group: "Entry filters",
    help: "e.g. 0.06: skip a signal when the 14-day ATR is more than 6% of the close." },
  { key: "max_per_sector", label: "Max positions per sector (null = off)", group: "Entry filters",
    help: "Sectors come from SIC codes (Download reference with details). A stock without one is its own sector." },
  { key: "sizing", label: "Sizing", group: "Risk & sizing", choices: ["risk", "equal"],
    help: "risk: risk_per_trade over the stop distance, capped by max_position_pct and the heat cap. equal: equity ÷ max_positions each, no heat cap." },
  { key: "risk_per_trade", label: "Risk per trade (fraction of equity, risk sizing)", group: "Risk & sizing" },
  { key: "max_position_pct", label: "Max position (fraction of equity, risk sizing)", group: "Risk & sizing" },
  { key: "max_positions", label: "Max positions", group: "Risk & sizing" },
  { key: "max_portfolio_heat", label: "Max total open risk (fraction of equity, risk sizing)", group: "Risk & sizing" },
];
/** Executor-only settings: runs that differ only in these share one signal scan (runBacktestMany). */
const EXEC_KEYS = new Set([...Object.keys(RISK).filter((k) => !(k in FILTERS) && k !== "atr_period"), "rank_by", "seed"]);

/** Seeded generator (mulberry32) keyed to a seed and a date: the same seed replays the same orderings. */
function rng(seed: number, d: string) {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ 0x85ebca6b;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "null", "", "none" or a non-number → null; otherwise the number. */
const optNum = (v: unknown) => (v == null || v === "" || v === "null" || v === "none" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Risk executor. Sizing "risk": next-open entries sized to risk `risk_per_trade` of equity over the
 * stop distance (stop_atr × ATR at the signal; 3 × ATR when stop_atr is null), capped at
 * max_position_pct, with max_positions slots and a max_portfolio_heat cap on total open risk.
 * Sizing "equal": equity ÷ max_positions per position (whole shares, prior close's equity), no heat cap.
 * The stop (and a target, if reward_risk is set) is fixed from the fill and worked intraday (gaps fill
 * at the open, stop first); a close disaster_stop_pct under the entry, or max_hold_days sessions held,
 * sells at the next open. With more signals than slots, `rank_by` decides who is bought first: "rs"
 * (the order `signals` returns), "rsi2" (lowest RSI(2) first) or "random" (shuffled each day from `seed`).
 */
function riskStrategy<P extends Risk>(spec: Spec<P>): StrategyDef<P> {
  const defaults = { ...RISK, ...spec.defaults } as P;
  return {
    name: spec.name, description: spec.description, defaults, fields: [...spec.fields, ...RISK_FIELDS], studyHorizons: spec.studyHorizons,
    warmupDays: warmupOf(spec, (p) => p.atr_period + 1),
    create(raw, env) {
      const p = { ...raw, stop_atr: optNum(raw.stop_atr), reward_risk: optNum(raw.reward_risk), disaster_stop_pct: optNum(raw.disaster_stop_pct),
        max_atr_pct: optNum(raw.max_atr_pct), max_per_sector: optNum(raw.max_per_sector) } as P;
      const sectors = new Map<string, string>(); // ticker → sector, for max_per_sector
      const sectorOf = (ctx: Ctx, t: string) => {
        let s = sectors.get(t);
        if (s == null) sectors.set(t, (s = momSector({ ticker: t, sic_code: ctx.tickers.get(t)?.sic_code ?? null })));
        return s;
      };
      const equal = p.sizing === "equal";
      // The day's scan and signal list (in rs order) are shared by every run with the same signal settings.
      const key = `scan:${spec.name}:${JSON.stringify(Object.entries(p).filter(([k]) => !EXEC_KEYS.has(k)).sort())}`;
      const shared = env.shared ?? new Map<string, unknown>();
      type Scan = { sc: ReturnType<typeof scanner<P>>; d: string | null; liquid: Liquid[]; riskOn: boolean; signals: string[] };
      let scan = shared.get(key) as Scan | undefined;
      if (!scan) shared.set(key, (scan = { sc: scanner(spec, p, p.atr_period + 1), d: null, liquid: [], riskOn: false, signals: [] }));
      const S = scan;
      const sc = S.sc;
      const today = (ctx: Ctx) => {
        if (S.d !== ctx.d) {
          const r = sc.update(ctx);
          S.liquid = r.liquid; S.riskOn = r.riskOn; S.d = ctx.d;
          S.signals = ctx.trading && r.riskOn ? spec.signals(ctx, r.liquid, { ...p, rank_by: "rs" }) : [];
        }
        return S;
      };
      const ordered = (ctx: Ctx, list: string[]) => {
        if (p.rank_by === "rsi2") {
          const at = new Map(list.map((t, k) => [t, k]));
          return [...list].sort((a, b) => sc.tapes.get(a)!.t.rsi - sc.tapes.get(b)!.t.rsi || at.get(a)! - at.get(b)!);
        }
        if (p.rank_by === "random") {
          const out = [...list], r = rng(Number(p.seed) || 0, ctx.d);
          for (let k = out.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [out[k], out[j]] = [out[j], out[k]]; }
          return out;
        }
        return list;
      };
      type Pos = { shares: number; entry: number; dist: number; stop: number | null; target: number | null; bars: number };
      const pos = new Map<string, Pos>();
      const distFor = new Map<string, number>(); // ticker → ATR stop distance at the signal
      let eqPrev = 0;
      let cash = 0;
      const heat = () => [...pos.values()].reduce((a, x) => a + x.shares * x.dist, 0);
      const levels = (entry: number, dist: number) => ({
        stop: p.stop_atr != null ? entry - dist : null,
        target: p.reward_risk != null ? entry + p.reward_risk * dist : null,
      });
      return {
        onClose(ctx) {
          const { riskOn, signals } = today(ctx);
          eqPrev = ctx.equity; cash = ctx.portfolio.cash;
          if (!ctx.trading) return [];
          const orders: Order[] = [];
          for (const [t, x] of pos) {
            if (ctx.portfolio.sharesOf(t) <= 0) { pos.delete(t); continue; }
            x.bars++;
            const c = ctx.row(t)?.c;
            if (p.disaster_stop_pct != null && c != null && c <= x.entry * (1 - p.disaster_stop_pct)) orders.push({ side: "sell", ticker: t, shares: "all", tag: "disaster_stop" });
            else if (x.bars >= p.max_hold_days) orders.push({ side: "sell", ticker: t, shares: "all", tag: "time_stop" });
            else if (x.stop != null || x.target != null) orders.push({ side: "sell", ticker: t, shares: "all", stop: x.stop ?? undefined, target: x.target ?? undefined });
          }
          if (!riskOn) return orders;
          distFor.clear();
          for (const t of ordered(ctx, signals)) {
            if (pos.has(t) || ctx.portfolio.sharesOf(t) > 0) continue;
            const atr = sc.tapes.get(t)!.t.atr(p.atr_period);
            const needAtr = !equal || p.stop_atr != null || p.reward_risk != null || p.max_atr_pct != null;
            if (needAtr && !(atr > 0)) continue;
            if (p.max_atr_pct != null && atr / ctx.row(t)!.c > p.max_atr_pct) continue;
            const sector = p.max_per_sector != null ? sectorOf(ctx, t) : "";
            const dist = atr > 0 ? (p.stop_atr ?? 3) * atr : 0;
            distFor.set(t, dist);
            orders.push({
              side: "buy", ticker: t, tag: "entry",
              shares: (price) => {
                if (pos.size >= p.max_positions) return 0;
                if (p.max_per_sector != null && [...pos.keys()].filter((h) => sectorOf(ctx, h) === sector).length >= p.max_per_sector) return 0;
                if (equal) return Math.max(0, Math.min(Math.floor(eqPrev / p.max_positions / price), Math.floor(cash / price)));
                if (!(price > dist)) return 0;
                const n = Math.min(Math.floor((eqPrev * p.risk_per_trade) / dist), Math.floor((eqPrev * p.max_position_pct) / price), Math.floor(cash / price));
                if (n <= 0 || heat() + n * dist > p.max_portfolio_heat * eqPrev) return 0;
                return n;
              },
              exits: (price) => { const l = levels(price, dist); return l.stop == null && l.target == null ? null : { stop: l.stop ?? undefined, target: l.target ?? undefined }; },
            });
          }
          return orders;
        },
        universe: sc.universe,
        onFill(f, ctx) {
          if (f.side === "buy") {
            const dist = distFor.get(f.ticker)!;
            pos.set(f.ticker, { shares: f.shares, entry: f.price, dist, ...levels(f.price, dist), bars: 0 });
          } else if (ctx.portfolio.sharesOf(f.ticker) <= 0) pos.delete(f.ticker);
          cash = ctx.portfolio.cash; // sales at the open fund the same morning's buys
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

/** Return from `from_days` to `skip_days` sessions ago, per liquid name, and its percentile among them. */
export function relativeStrength<X extends { r: Row; t: Tape }>(liquid: X[], fromDays: number, skipDays: number) {
  const scored = liquid.map((x) => ({ x, m: x.t.n > fromDays ? x.t.close(skipDays) / x.t.close(fromDays) - 1 : NaN })).filter((y) => Number.isFinite(y.m));
  const sorted = scored.map((y) => y.m).sort((a, b) => a - b);
  return scored.map((y) => ({ ...y, pct: pctRank(sorted, y.m) }));
}

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

export const rsi2Deep = signalStrategy<Rsi2>({
  name: "rsi2_deep",
  description: "Signal study: rsi2 with a deeper oversold level, 2-day RSI (Wilder) under 5, close above its 200-day average; SPY above its 200-day.",
  defaults: { rsi_max: 5, trend_ma: 200, hold_days: 5 },
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

type RsRsi2 = Risk & { from_days: number; skip_days: number; top_pct: number; rsi_max: number; trend_ma: number };
export const rsRsi2 = riskStrategy<RsRsi2>({
  name: "rs_rsi2",
  description: "Top 20% by return from 126 to 21 sessions ago (ranked daily) AND 2-day RSI under 10 AND close above its 200-day; SPY above its 200-day. 3 × ATR stop, 20-session time exit, 0.75% risk per trade.",
  defaults: { from_days: 126, skip_days: 21, top_pct: 0.2, rsi_max: 10, trend_ma: 200, rank_by: "rs", seed: 1 },
  fields: [
    { key: "from_days", label: "Return from (sessions ago)", group: "Signal" },
    { key: "skip_days", label: "… to (sessions ago)", group: "Signal" },
    { key: "top_pct", label: "Top fraction (0.2 = top 20%)", group: "Signal" },
    { key: "rsi_max", label: "RSI(2) under", group: "Signal" },
    { key: "trend_ma", label: "Close above MA (days)", group: "Signal" },
    { key: "rank_by", label: "More signals than slots: buy first by", group: "Signal", choices: ["rs", "rsi2", "random"],
      help: "rs: strongest 126→21-day return first. rsi2: most oversold (lowest RSI(2)) first. random: shuffled each day from the seed." },
    { key: "seed", label: "Random seed (rank_by random)", group: "Signal" },
  ],
  studyHorizons: [3, 5, 10, 15],
  bars: (p) => Math.max(p.trend_ma, p.from_days + 1),
  smas: (p) => [p.trend_ma],
  signals: (_ctx, liquid, p) => relativeStrength(liquid, p.from_days, p.skip_days)
    .filter(({ x, pct }) => pct > 1 - p.top_pct && x.t.rsi < p.rsi_max && x.r.c > x.ma[0])
    .sort((a, b) => (p.rank_by === "rsi2" ? a.x.t.rsi - b.x.t.rsi || b.m - a.m : b.m - a.m || a.x.t.rsi - b.x.t.rsi)) // the executor reorders for rank_by
    .map(({ x }) => x.r.ticker),
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
  studyHorizons: [10, 20, 40, 60],
  bars: (p) => p.from_days + 1,
  smas: () => [],
  signals: (ctx, liquid, p) => {
    // First trading day of the week: the previous session closed a week.
    if (ctx.i === 0 || !isWeekEnd(ctx.cal, ctx.days[ctx.i - 1])) return [];
    return relativeStrength(liquid, p.from_days, p.skip_days).filter((y) => y.pct > 1 - p.top_pct).sort((a, b) => b.m - a.m).map((y) => y.x.r.ticker);
  },
});

type GapDrift = Base & { gap_pct: number; vol_days: number; vol_mult: number; close_in_range: number };
export const gapDrift = signalStrategy<GapDrift>({
  name: "gap_drift",
  description: "Signal study: opens ≥ 5% above the prior close on ≥ 3× its 50-day average volume and closes in the top half of the day's range; price over $10, liquidity filter.",
  defaults: { gap_pct: 0.05, vol_days: 50, vol_mult: 3, close_in_range: 0.5, use_market_filter: false, hold_days: 10 },
  fields: [
    { key: "gap_pct", label: "Open ≥ prior close × (1 + this)", group: "Signal" },
    { key: "vol_days", label: "Volume average (prior days)", group: "Signal" },
    { key: "vol_mult", label: "Volume ≥ × average", group: "Signal" },
    { key: "close_in_range", label: "Close in the top part of the range (0.5 = top half)", group: "Signal" },
  ],
  studyHorizons: [5, 10, 20, 40],
  bars: (p) => p.vol_days + 2,
  smas: () => [],
  signals: (_ctx, liquid, p) => liquid
    .filter(({ r, t }) => {
      if (!(r.c > p.min_price) || t.n < 2) return false;
      const pc = t.close(1), avgV = t.mean("v", p.vol_days, 1);
      return r.o >= pc * (1 + p.gap_pct) && r.v >= p.vol_mult * avgV && r.h > r.l && (r.c - r.l) / (r.h - r.l) >= p.close_in_range;
    })
    .sort((a, b) => b.r.o / b.t.close(1) - a.r.o / a.t.close(1))
    .map((x) => x.r.ticker),
});

type EtfRsi2 = Base & { tickers: string; rsi_max: number; trend_ma: number };
export const etfRsi2 = signalStrategy<EtfRsi2>({
  name: "etf_rsi2",
  description: "Signal study: SPY, QQQ and the sector SPDRs with 2-day RSI (Wilder) under 10 and the close above the 200-day average. Baseline: the same ETFs on every day.",
  defaults: {
    tickers: "SPY,QQQ,XLB,XLC,XLE,XLF,XLI,XLK,XLP,XLRE,XLU,XLV,XLY", rsi_max: 10, trend_ma: 200,
    min_price: 0, min_avg_dollar_vol: 0, common_only: false, use_market_filter: false, market_ticker: "", hold_days: 5,
  },
  fields: [
    { key: "tickers", label: "ETFs (comma-separated)", group: "Signal" },
    { key: "rsi_max", label: "RSI(2) under", group: "Signal" },
    { key: "trend_ma", label: "Close above MA (days)", group: "Signal" },
  ],
  studyHorizons: [3, 5, 10],
  bars: (p) => p.trend_ma,
  smas: (p) => [p.trend_ma],
  restrict: (_ctx, liquid, p) => { const set = new Set(String(p.tickers).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)); return liquid.filter((x) => set.has(x.r.ticker)); },
  signals: (_ctx, liquid, p) => liquid
    .filter(({ r, t, ma: [m] }) => t.rsi < p.rsi_max && r.c > m)
    .sort((a, b) => a.t.rsi - b.t.rsi)
    .map((x) => x.r.ticker),
});

type LcReversal = Base & { top_n: number; adv_days: number; ret_days: number; bottom_pct: number; trend_ma: number };
export const lcReversal = signalStrategy<LcReversal>({
  name: "lc_reversal",
  description: "Signal study: among the 500 stocks with the highest 50-day average dollar volume, the bottom 5% by 5-day return with the close above the 200-day average. Baseline: the same 500 stocks.",
  defaults: { top_n: 500, adv_days: 50, ret_days: 5, bottom_pct: 0.05, trend_ma: 200, min_price: 0, min_avg_dollar_vol: 0, use_market_filter: false, hold_days: 5 },
  fields: [
    { key: "top_n", label: "Universe: top N by average dollar volume", group: "Signal" },
    { key: "adv_days", label: "Dollar-volume average (days)", group: "Signal" },
    { key: "ret_days", label: "Return over (sessions)", group: "Signal" },
    { key: "bottom_pct", label: "Bottom fraction (0.05 = bottom 5%)", group: "Signal" },
    { key: "trend_ma", label: "Close above MA (days)", group: "Signal" },
  ],
  studyHorizons: [5, 10],
  bars: (p) => Math.max(p.trend_ma, p.adv_days, p.ret_days + 1),
  smas: (p) => [p.trend_ma],
  restrict: (_ctx, liquid, p) => liquid
    .map((x) => ({ x, adv: x.t.mean("dv", p.adv_days) }))
    .filter((y) => Number.isFinite(y.adv))
    .sort((a, b) => b.adv - a.adv || a.x.r.ticker.localeCompare(b.x.r.ticker))
    .slice(0, p.top_n)
    .map((y) => y.x),
  signals: (_ctx, liquid, p) => {
    const scored = liquid.map((x) => ({ x, ret: x.t.n > p.ret_days ? x.r.c / x.t.close(p.ret_days) - 1 : NaN })).filter((y) => Number.isFinite(y.ret));
    const sorted = scored.map((y) => y.ret).sort((a, b) => a - b);
    return scored
      .filter((y) => pctRank(sorted, y.ret) <= p.bottom_pct && y.x.r.c > y.x.ma[0])
      .sort((a, b) => a.ret - b.ret)
      .map((y) => y.x.r.ticker);
  },
});
