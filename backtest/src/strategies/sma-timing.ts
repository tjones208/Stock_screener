// Trend timing on one ticker: hold it while its month-end close is at or above its N-month average,
// otherwise cash. Checked at month-ends only.
import type { StrategyDef } from "../engine/engine.ts";

export const smaTiming: StrategyDef<{ ticker: string; months: number }> = {
  name: "sma-timing",
  description: "Hold one ticker (default SPY) while its month-end close ≥ its N-month SMA (default 10); else cash.",
  defaults: { ticker: "SPY", months: 10 },
  warmupDays: 260,
  create(p) {
    const monthCloses: number[] = [];
    return {
      onClose(ctx) {
        const r = ctx.row(p.ticker);
        if (!r || !ctx.isMonthEnd) return [];
        monthCloses.push(r.c);
        if (!ctx.trading || monthCloses.length < p.months) return [];
        const sma = monthCloses.slice(-p.months).reduce((a, b) => a + b, 0) / p.months;
        const held = ctx.portfolio.sharesOf(p.ticker) > 0;
        if (r.c >= sma && !held) return [{ side: "buy", ticker: p.ticker, shares: (price) => Math.floor((ctx.portfolio.cash / price) * 1000) / 1000, tag: "trend on" }];
        if (r.c < sma && held) return [{ side: "sell", ticker: p.ticker, shares: "all", tag: "trend off" }];
        return [];
      },
    };
  },
};
