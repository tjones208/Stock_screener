// Example drop-in strategy: every file in this folder shows up in the app's strategy library.
// Monthly: among liquid common stocks with positive 12-month momentum, hold the N with the lowest
// 63-day volatility, equally weighted.
import type { StrategyDef } from "../src/engine/engine.ts";

export const lowVolMomentum: StrategyDef<{ n: number; minPrice: number; minDollarVol: number }> = {
  name: "low-vol-momentum",
  description: "Monthly: lowest-volatility N stocks among those with positive 12-month momentum, equal weight.",
  defaults: { n: 15, minPrice: 10, minDollarVol: 2e7 },
  fields: [
    { key: "n", label: "Positions" },
    { key: "minPrice", label: "Min price ($)" },
    { key: "minDollarVol", label: "Min median 60-day $ volume" },
  ],
  warmupDays: 0,
  create(p) {
    return {
      onClose(ctx) {
        if (!ctx.trading || !ctx.isMonthEnd) return [];
        const picks = [...ctx.today.values()]
          .filter((r) => ctx.tickers.get(r.ticker)?.type === "CS" && r.c >= p.minPrice && (r.median_dv60 ?? 0) >= p.minDollarVol)
          .filter((r) => (r.ret252 ?? -1) > 0 && r.vol63 != null)
          .sort((a, b) => a.vol63! - b.vol63!)
          .slice(0, p.n)
          .map((r) => r.ticker);
        const held = ctx.portfolio.tickers();
        const target = ctx.equity / p.n;
        return [
          ...held.filter((t) => !picks.includes(t)).map((t) => ({ side: "sell" as const, ticker: t, shares: "all" as const, tag: "out" })),
          ...picks.filter((t) => !held.includes(t)).map((t) => ({ side: "buy" as const, ticker: t, shares: (price: number) => Math.floor(target / price), tag: "in" })),
        ];
      },
    };
  },
};
