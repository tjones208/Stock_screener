// Buy one ticker and hold it; dividends are reinvested at the next open. The benchmark strategy.
import type { StrategyDef } from "../engine/engine.ts";

export const buyHold: StrategyDef<{ ticker: string; reinvest: boolean }> = {
  name: "buyhold",
  description: "Buy and hold one ticker (default SPY), reinvesting dividends.",
  defaults: { ticker: "SPY", reinvest: true },
  warmupDays: 0,
  create(p) {
    return {
      onClose(ctx) {
        const r = ctx.row(p.ticker);
        if (!r) return [];
        const held = ctx.portfolio.sharesOf(p.ticker) > 0;
        // Spend idle cash: all of it at the start, dividends once they add up to 0.5% of equity.
        if (!held || (p.reinvest && ctx.portfolio.cash > 0.005 * ctx.equity)) {
          return [{ side: "buy", ticker: p.ticker, shares: (price) => Math.floor((ctx.portfolio.cash / price) * 1000) / 1000, tag: "buy" }];
        }
        return [];
      },
    };
  },
};
