// Momentum pullback swing: buy a pullback in a strong uptrend once price turns back up, with a
// swing-low stop, a fixed-R target, a close-under-the-fast-MA exit and a time stop. Ported from the
// Python spec; the rules live in lib/pullback/core.ts, shared with the app's daily scan. Signals on
// the close, entries at the next open, stop and target worked through each session (stop first).
//
// Differences from the Python: by default the relative-strength percentile ranks only stocks that
// pass the price and dollar-volume filters (rs_universe "all" ranks every ticker, as the Python does);
// dollar volume is the unadjusted close × volume; prices are split-adjusted with dividends paid as
// cash (not dividend-adjusted); `common_only` keeps ETFs and other non-common shares out; starting
// capital, slippage and commission are the run's settings, not strategy parameters.
import type { StrategyDef } from "../engine/engine.ts";
import type { Portfolio } from "../engine/portfolio.ts";
import type { Order, Row } from "../engine/types.ts";
import { entryShares, entryStop, Hist, PB_DEFAULTS, PB_FIELDS, pbHistoryBars, pctRank, type PbParams } from "../../../lib/pullback/core.ts";

type Pos = { shares: number; entry: number; stop: number; rps: number; target: number; bars: number };

export const pullback: StrategyDef<PbParams> = {
  name: "pullback",
  description: "Momentum pullback swing: strong uptrend + top-RS stock pulls back, then closes above the prior high. Swing-low stop, 2R target, 20MA and 15-day exits, 0.75% risk per trade.",
  defaults: PB_DEFAULTS,
  fields: PB_FIELDS,
  // Enough bars for the longest lookback, plus a margin for tickers with gaps.
  warmupDays: (p) => Math.ceil(Math.max(p.slow_ma, p.rs_lookback + 1, p.mid_ma) * 1.1) + 10,
  create(p) {
    const N = pbHistoryBars(p);
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
          const rs = pctRank(sorted, mom);
          const stop = entryStop(h, r.c, rs, p);
          if (stop != null) signals.push({ t: r.ticker, rs, stop });
        }
        signals.sort((a, b) => b.rs - a.rs);
        stopFor.clear();
        for (const s of signals) {
          stopFor.set(s.t, s.stop);
          orders.push({
            side: "buy", ticker: s.t, tag: "entry",
            // Sized at the real fill: risk budget ÷ (fill − stop), position cap, cash, heat cap.
            shares: (price) => entryShares({ price, stop: s.stop, equity: eqPrev, cash: pf?.cash ?? 0, openHeat: heat(), openCount: pos.size }, p),
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
