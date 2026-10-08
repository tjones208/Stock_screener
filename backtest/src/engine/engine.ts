// Daily event loop. Each trading day: dividends (ex-date) → work yesterday's orders at today's open
// (sells first, then buys) → stop / target orders through the session → delisting check → mark to
// market at the close → the strategy sees the close and places orders for the next session. No
// look-ahead: a strategy only sees rows up to today.
import { isMonthEnd, isWeekEnd, type Calendar } from "../../../lib/momentum/calendar.ts";
import { Portfolio, type LotOrder } from "./portfolio.ts";
import type { ClosedLot, Dividend, EquityPoint, Fill, Lot, Order, Row, SellOrder, TickerInfo, Unfilled } from "./types.ts";

export interface DataSource {
  /** Trading days, sorted. */
  days(): string[];
  /** Rows for every ticker on each trading day in [from, to], keyed by date then ticker. */
  rows(from: string, to: string): Promise<Map<string, Map<string, Row>>>;
  tickers(): Map<string, TickerInfo>;
  /** Dividends keyed by ex-date. */
  dividends(): Map<string, Dividend[]>;
}

export type Ctx = {
  d: string;
  /** Index of d in `days`. */
  i: number;
  days: string[];
  cal: Calendar;
  /** False during the warm-up period: orders are ignored. */
  trading: boolean;
  today: Map<string, Row>;
  row: (ticker: string) => Row | undefined;
  /** Last known close (today's, or the latest before it for a ticker with no bar today). */
  lastClose: (ticker: string) => number | undefined;
  portfolio: Portfolio;
  equity: number;
  tickers: Map<string, TickerInfo>;
  isMonthEnd: boolean;
  isWeekEnd: boolean;
};

export interface StrategyInstance {
  onClose(ctx: Ctx): Order[];
  onFill?(fill: Fill, ctx: Ctx, lot?: Lot, closed?: ClosedLot[]): void;
  onUnfilled?(u: Unfilled, ctx: Ctx): void;
  /** Tickers the strategy picks from today (after its liquidity filters): the baseline of a signal study. */
  universe?(ctx: Ctx): string[];
}

/** Form metadata for a parameter (labels, groups, allowed values); optional. */
export type ParamField = { key: string; label: string; group?: string; choices?: readonly string[]; help?: string };

export interface StrategyDef<P extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  defaults: P;
  fields?: ParamField[];
  /** Trading days the strategy watches before it may trade (e.g. to build a regime history), or a function of the parameters. */
  warmupDays: number | ((params: P) => number);
  create(params: P, env: { capital: number }): StrategyInstance;
}

export type RunOptions = {
  from: string;
  to: string;
  capital: number;
  /** Slippage per side, basis points of the price (applied at the open; limit fills at the limit). */
  slippageBps?: number;
  commission?: number;     // $ per order
  lotOrder?: LotOrder;     // default lot choice for share-count sells
  delistAfter?: number;    // trading days without a bar before a holding is closed at its last close
  chunkDays?: number;      // trading days loaded per chunk
  /** Called about every 20 trading days with (days done, total days). */
  onProgress?: (done: number, total: number) => void;
};

export type RunResult = {
  equity: EquityPoint[];
  fills: Fill[];
  closed: ClosedLot[];
  unfilled: number;
  dividends: number;
  dividendsByYear: Map<string, number>;
  commissions: number;
  open: Lot[];
  finalPrices: Record<string, number>;
};

export async function runBacktest(data: DataSource, def: StrategyDef, params: Record<string, unknown>, opt: RunOptions): Promise<RunResult> {
  const all = data.days();
  const cal: Calendar = { traded: all, holidays: new Set() };
  const startIdx = all.findIndex((d) => d >= opt.from);
  const endIdx = (() => { let k = -1; for (let j = 0; j < all.length; j++) if (all[j] <= opt.to) k = j; return k; })();
  if (startIdx < 0 || endIdx < startIdx) throw new Error(`No trading days between ${opt.from} and ${opt.to}`);
  const merged = { ...def.defaults, ...params };
  const warmup = typeof def.warmupDays === "function" ? def.warmupDays(merged) : def.warmupDays;
  const firstIdx = Math.max(0, startIdx - warmup);
  const slip = (opt.slippageBps ?? 0) / 10_000;
  const commission = opt.commission ?? 0;
  const delistAfter = opt.delistAfter ?? 10;
  const chunk = opt.chunkDays ?? 21;

  const pf = new Portfolio(opt.capital);
  const strat = def.create(merged, { capital: opt.capital });
  const tickers = data.tickers();
  const divs = data.dividends();
  const equity: EquityPoint[] = [];
  const fills: Fill[] = [];
  let unfilledCount = 0;
  const last = new Map<string, { c: number; i: number }>(); // last close seen per ticker
  let pending: Order[] = [];
  let pendingSells: { order: Order; since: number }[] = [];

  let loaded = new Map<string, Map<string, Row>>();
  let loadedTo = -1;
  for (let i = firstIdx; i <= endIdx; i++) {
    if (opt.onProgress && (i - firstIdx) % 20 === 0) opt.onProgress(i - firstIdx, endIdx - firstIdx + 1);
    if (i > loadedTo) {
      const to = Math.min(endIdx, i + chunk - 1);
      loaded = await data.rows(all[i], all[to]);
      loadedTo = to;
    }
    const d = all[i];
    const today = loaded.get(d) ?? new Map<string, Row>();
    const trading = i >= startIdx;
    for (const [t, r] of today) last.set(t, { c: r.c, i });
    const lastClose = (t: string) => today.get(t)?.c ?? last.get(t)?.c;
    const ctx: Ctx = {
      d, i, days: all, cal, trading, today, row: (t) => today.get(t), lastClose, portfolio: pf, equity: 0, tickers,
      isMonthEnd: isMonthEnd(cal, d), isWeekEnd: isWeekEnd(cal, d),
    };

    if (trading) {
      // 1. Dividends with today's ex-date go to shares held from before today.
      for (const dv of divs.get(d) ?? []) if (pf.sharesOf(dv.ticker) > 0) pf.dividend(dv.ticker, dv.cash, d);

      // 2. Work yesterday's orders: sells (and sells waiting for a bar) first, then buys.
      const orders = [...pendingSells.map((p) => p.order), ...pending];
      const since = new Map(pendingSells.map((p) => [p.order, p.since]));
      pendingSells = [];
      pending = [];
      const isCond = (o: Order) => o.side === "sell" && (o.stop != null || o.target != null);
      const cond: { o: SellOrder; sameDay: boolean }[] = orders.filter(isCond).map((o) => ({ o: o as SellOrder, sameDay: false }));
      for (const o of orders.filter((x) => x.side === "sell" && !isCond(x))) {
        if (o.side !== "sell") continue;
        const bar = today.get(o.ticker);
        if (!bar) { pendingSells.push({ order: o, since: since.get(o) ?? i }); continue; }
        const price = bar.o * (1 - slip);
        const closed = o.lots ? pf.sellLots(o.lots, price, d, commission, o.tag) : pf.sell(o.ticker, o.shares, price, d, opt.lotOrder, commission, o.tag);
        const shares = closed.reduce((a, c) => a + c.shares, 0);
        if (shares > 0) {
          const f: Fill = { d, side: "sell", ticker: o.ticker, shares, price, tag: o.tag };
          fills.push(f);
          strat.onFill?.(f, ctx, undefined, closed);
        }
      }
      for (const o of orders.filter((x) => x.side === "buy")) {
        if (o.side !== "buy") continue;
        const bar = today.get(o.ticker);
        const miss = (reason: Unfilled["reason"]) => { unfilledCount++; strat.onUnfilled?.({ d, order: o, reason }, ctx); };
        if (!bar) { miss("no_bar"); continue; }
        let price = bar.o * (1 + slip);
        if (o.limit != null && bar.o > o.limit) {
          if (bar.l <= o.limit) price = o.limit; else { miss("limit"); continue; }
        } else if (o.limit != null) price = Math.min(price, o.limit);
        let shares = typeof o.shares === "function" ? o.shares(price) : o.shares;
        const affordable = Math.floor(((pf.cash - commission) / price) * 1000) / 1000;
        if (shares > affordable) shares = Number.isInteger(shares) ? Math.floor(affordable) : affordable;
        if (!(shares > 0)) { miss(pf.cash < price ? "cash" : "zero_shares"); continue; }
        const lot = pf.buy(o.ticker, shares, price, d, commission, o.tag);
        const f: Fill = { d, side: "buy", ticker: o.ticker, shares, price, tag: o.tag, lotId: lot.id };
        fills.push(f);
        strat.onFill?.(f, ctx, lot);
        const ex = o.exits?.(price);
        if (ex && (ex.stop != null || ex.target != null)) {
          cond.push({ o: { side: "sell", ticker: o.ticker, shares, lots: [{ id: lot.id, shares }], stop: ex.stop, target: ex.target }, sameDay: true });
        }
      }

      // 2b. Stop / target orders through the session (no bar today → the order lapses).
      for (const { o, sameDay } of cond) {
        const bar = today.get(o.ticker);
        if (!bar || pf.sharesOf(o.ticker) <= 0) continue;
        let px: number | null = null, why = "";
        if (o.stop != null && !sameDay && bar.o <= o.stop) { px = bar.o; why = "stop_gap"; }
        else if (o.stop != null && bar.l <= o.stop) { px = o.stop; why = "stop"; }
        else if (o.target != null && !sameDay && bar.o >= o.target) { px = bar.o; why = "target_gap"; }
        else if (o.target != null && bar.h >= o.target) { px = o.target; why = "target"; }
        if (px == null) continue;
        const price = px * (1 - slip), tag = why;
        const closed = o.lots ? pf.sellLots(o.lots, price, d, commission, tag) : pf.sell(o.ticker, o.shares, price, d, opt.lotOrder, commission, tag);
        const shares = closed.reduce((a, c) => a + c.shares, 0);
        if (shares > 0) {
          const f: Fill = { d, side: "sell", ticker: o.ticker, shares, price, tag };
          fills.push(f);
          strat.onFill?.(f, ctx, undefined, closed);
        }
      }

      // 3. Delisted or long-halted holdings: closed at the last known close.
      for (const t of pf.tickers()) {
        const seen = last.get(t);
        if (!today.has(t) && seen && i - seen.i >= delistAfter) {
          const closed = pf.sell(t, "all", seen.c, d, "fifo", 0, "delisted");
          pendingSells = pendingSells.filter((p) => p.order.ticker !== t);
          const f: Fill = { d, side: "sell", ticker: t, shares: closed.reduce((a, c) => a + c.shares, 0), price: seen.c, tag: "delisted" };
          fills.push(f);
          strat.onFill?.(f, ctx, undefined, closed);
        }
      }
    }

    // 4. Mark to market at the close.
    const invested = pf.value(lastClose);
    ctx.equity = pf.cash + invested;
    if (trading) equity.push({ d, equity: ctx.equity, cash: pf.cash, invested, positions: pf.tickers().length });

    // 5. The strategy sees the close; its orders work at the next open.
    const orders = strat.onClose(ctx);
    if (trading && i < endIdx) pending = orders;
  }
  const finalPrices: Record<string, number> = {};
  for (const l of pf.lots) finalPrices[l.ticker] = last.get(l.ticker)?.c ?? l.price;
  return { equity, fills, closed: pf.closed, unfilled: unfilledCount, dividends: pf.dividends, dividendsByYear: pf.dividendsByYear, commissions: pf.commissions, open: pf.lots, finalPrices };
}
