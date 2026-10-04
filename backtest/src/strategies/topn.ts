// A minimal cross-sectional template: every month-end rank the liquid common stocks by one feature,
// hold the top N equally weighted, keep holdings while they stay within the top N × buffer.
// Copy this file to start a new strategy.
import type { StrategyDef } from "../engine/engine.ts";
import type { Row } from "../engine/types.ts";

type P = { feature: keyof Row; n: number; buffer: number; minPrice: number; minDollarVol: number; commonOnly: boolean };

export const topN: StrategyDef<P> = {
  name: "topn",
  description: "Monthly: top N liquid common stocks by a feature (default mom_12_1), equal weight, hold-buffer.",
  defaults: { feature: "mom_12_1", n: 20, buffer: 2, minPrice: 5, minDollarVol: 5e6, commonOnly: true },
  warmupDays: 0,
  create(p) {
    return {
      onClose(ctx) {
        if (!ctx.trading || !ctx.isMonthEnd) return [];
        const ranked = [...ctx.today.values()]
          .filter((r) => r.c >= p.minPrice && (r.median_dv60 ?? 0) >= p.minDollarVol && typeof r[p.feature] === "number")
          .filter((r) => !p.commonOnly || ctx.tickers.get(r.ticker)?.type === "CS")
          .sort((a, b) => (b[p.feature] as number) - (a[p.feature] as number));
        const rank = new Map(ranked.map((r, i) => [r.ticker, i + 1]));
        const held = ctx.portfolio.tickers();
        const keep = held.filter((t) => (rank.get(t) ?? Infinity) <= p.n * p.buffer);
        const sells = held.filter((t) => !keep.includes(t)).map((t) => ({ side: "sell" as const, ticker: t, shares: "all" as const, tag: "dropped" }));
        const adds = ranked.map((r) => r.ticker).filter((t) => !keep.includes(t)).slice(0, Math.max(0, p.n - keep.length));
        const target = ctx.equity / p.n;
        return [...sells, ...adds.map((t) => ({ side: "buy" as const, ticker: t, shares: (price: number) => Math.floor(target / price), tag: "top" }))];
      },
    };
  },
};
