// Performance statistics from an equity curve and the closed trades (pure, tested).
import type { ClosedLot, EquityPoint } from "./types.ts";

const yearsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / (365.25 * 86_400_000);

export type TaxRates = { st: number; lt: number };

/**
 * Federal-style yearly tax on realized gains: net short-term and long-term separately, offset one
 * against the other, carry a net loss forward. Dividends are taxed as short-term (ordinary).
 */
export function yearlyTaxes(closed: ClosedLot[], dividendsByYear: Map<string, number>, rates: TaxRates) {
  const years = new Map<string, { st: number; lt: number }>();
  for (const c of closed) {
    const y = c.exitD.slice(0, 4);
    const v = years.get(y) ?? { st: 0, lt: 0 };
    if (c.term === "LT") v.lt += c.pnl; else v.st += c.pnl;
    years.set(y, v);
  }
  for (const [y, amt] of dividendsByYear) {
    const v = years.get(y) ?? { st: 0, lt: 0 };
    v.st += amt;
    years.set(y, v);
  }
  let carryST = 0, carryLT = 0;
  const out: { year: string; st: number; lt: number; tax: number }[] = [];
  for (const y of [...years.keys()].sort()) {
    let st = years.get(y)!.st + carryST, lt = years.get(y)!.lt + carryLT;
    carryST = carryLT = 0;
    if (st < 0 && lt > 0) { lt += st; st = 0; } else if (lt < 0 && st > 0) { st += lt; lt = 0; }
    if (st < 0) { carryST = st; st = 0; }
    if (lt < 0) { carryLT = lt; lt = 0; }
    out.push({ year: y, st, lt, tax: st * rates.st + lt * rates.lt });
  }
  return out;
}

export type Stats = {
  start: string; end: string; years: number;
  startValue: number; endValue: number; totalReturn: number; cagr: number;
  volatility: number; sharpe: number | null; sortino: number | null;
  maxDrawdown: number; maxDrawdownStart: string | null; maxDrawdownEnd: string | null; calmar: number | null;
  bestMonth: number | null; worstMonth: number | null; pctPositiveMonths: number | null;
  exposure: number;           // average invested / equity
  turnover: number;           // yearly sells ÷ average equity
  trades: number; winRate: number | null; avgWin: number | null; avgLoss: number | null; profitFactor: number | null;
  avgHoldDays: number | null;
  taxes: number; afterTaxEndValue: number; afterTaxCagr: number;
};

export function computeStats(eq: EquityPoint[], closed: ClosedLot[], o: { dividends?: Map<string, number>; tax?: TaxRates; unrealizedGain?: number; rf?: number } = {}): Stats {
  if (eq.length < 2) throw new Error("Need at least two equity points");
  const start = eq[0], end = eq[eq.length - 1];
  const years = Math.max(yearsBetween(start.d, end.d), 1 / 365);
  const rets = eq.slice(1).map((p, i) => p.equity / eq[i].equity - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1));
  const downside = Math.sqrt(rets.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / Math.max(rets.length - 1, 1));
  const rfDaily = (o.rf ?? 0) / 252;
  let peak = eq[0].equity, peakD = eq[0].d, mdd = 0, mddS: string | null = null, mddE: string | null = null;
  for (const p of eq) {
    if (p.equity > peak) { peak = p.equity; peakD = p.d; }
    const dd = p.equity / peak - 1;
    if (dd < mdd) { mdd = dd; mddS = peakD; mddE = p.d; }
  }
  // Month-end returns.
  const monthEnds: EquityPoint[] = [];
  for (let i = 0; i < eq.length; i++) if (i === eq.length - 1 || eq[i + 1].d.slice(0, 7) !== eq[i].d.slice(0, 7)) monthEnds.push(eq[i]);
  const mrets = [eq[0], ...monthEnds].slice(1).map((p, i, arr) => p.equity / (i === 0 ? eq[0].equity : arr[i - 1].equity) - 1);
  const cagr = (end.equity / start.equity) ** (1 / years) - 1;
  const wins = closed.filter((c) => c.pnl > 0), losses = closed.filter((c) => c.pnl <= 0);
  const sold = closed.reduce((a, c) => a + c.exit * c.shares, 0);
  const avgEq = eq.reduce((a, p) => a + p.equity, 0) / eq.length;
  const divs = o.dividends ?? new Map<string, number>();
  const taxes = o.tax ? yearlyTaxes(closed, divs, o.tax).reduce((a, y) => a + y.tax, 0) : 0;
  const unreal = o.tax ? Math.max(0, o.unrealizedGain ?? 0) * o.tax.st : 0;
  const afterTax = end.equity - taxes - unreal;
  return {
    start: start.d, end: end.d, years,
    startValue: start.equity, endValue: end.equity, totalReturn: end.equity / start.equity - 1, cagr,
    volatility: sd * Math.sqrt(252),
    sharpe: sd > 0 ? ((mean - rfDaily) / sd) * Math.sqrt(252) : null,
    sortino: downside > 0 ? ((mean - rfDaily) / downside) * Math.sqrt(252) : null,
    maxDrawdown: mdd, maxDrawdownStart: mddS, maxDrawdownEnd: mddE, calmar: mdd < 0 ? cagr / -mdd : null,
    bestMonth: mrets.length ? Math.max(...mrets) : null, worstMonth: mrets.length ? Math.min(...mrets) : null,
    pctPositiveMonths: mrets.length ? mrets.filter((r) => r > 0).length / mrets.length : null,
    exposure: eq.reduce((a, p) => a + (p.equity > 0 ? p.invested / p.equity : 0), 0) / eq.length,
    turnover: avgEq > 0 ? sold / avgEq / years : 0,
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgWin: wins.length ? wins.reduce((a, c) => a + c.ret, 0) / wins.length : null,
    avgLoss: losses.length ? losses.reduce((a, c) => a + c.ret, 0) / losses.length : null,
    profitFactor: losses.length && losses.reduce((a, c) => a + c.pnl, 0) < 0 ? wins.reduce((a, c) => a + c.pnl, 0) / -losses.reduce((a, c) => a + c.pnl, 0) : null,
    avgHoldDays: closed.length ? closed.reduce((a, c) => a + c.days, 0) / closed.length : null,
    taxes: taxes + unreal, afterTaxEndValue: afterTax, afterTaxCagr: (Math.max(afterTax, 1e-9) / start.equity) ** (1 / years) - 1,
  };
}
