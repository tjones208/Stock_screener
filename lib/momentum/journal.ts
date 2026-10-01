// Equity journal and benchmark (pure, tested): nightly strategy value vs SPY / MTUM, after-tax
// estimates and the trade statistics shown on the Momentum tab.
import type { MomConfig } from "./config.ts";

export type OpenLotV = { shares: number; fill_price: number; close: number; lt_date: string };
export type ClosedLotV = { pnl: number | null; term: string | null; exit_date: string; exit_price: number | null; shares: number; r_multiple: number | null; days_held: number | null };
export type EquityRow = {
  d: string; b: number; invested: number; open_value: number; realized: number; cash: number; strategy_value: number;
  spy_value: number | null; mtum_value: number | null; realized_st_ytd: number; realized_lt_ytd: number; tax_est: number;
  after_tax_value: number; vol_scale: number | null;
};

const pos = (x: number) => Math.max(0, x);

/**
 * One night's row. Strategy value = open lots at the close + realized P&L + cash (B − invested).
 * Benchmarks start from the first row's strategy value. Tax: each year's realized ST and LT gains at
 * tax_rate_st / tax_rate_lt (losses offset within their own bucket), plus tax on unrealized gains as
 * if sold tonight.
 */
export function equityRow(a: {
  d: string; b: number; open: OpenLotV[]; closed: ClosedLotV[]; spy: number | null; mtum: number | null; m: number | null;
  first: { strategy_value: number; spy: number | null; mtum: number | null } | null;
  cfg: Pick<MomConfig, "tax_rate_st" | "tax_rate_lt">;
}): EquityRow {
  const invested = a.open.reduce((s, l) => s + l.shares * l.fill_price, 0);
  const open_value = a.open.reduce((s, l) => s + l.shares * l.close, 0);
  const realized = a.closed.reduce((s, l) => s + (l.pnl ?? 0), 0);
  const cash = a.b - invested;
  const strategy_value = open_value + realized + cash;
  const year = a.d.slice(0, 4);
  const byYear = new Map<string, { st: number; lt: number }>();
  for (const l of a.closed) {
    const y = l.exit_date.slice(0, 4);
    const v = byYear.get(y) ?? { st: 0, lt: 0 };
    if (l.term === "LT") v.lt += l.pnl ?? 0; else v.st += l.pnl ?? 0;
    byYear.set(y, v);
  }
  let tax = 0;
  for (const v of byYear.values()) tax += pos(v.st) * a.cfg.tax_rate_st + pos(v.lt) * a.cfg.tax_rate_lt;
  let ust = 0, ult = 0;
  for (const l of a.open) {
    const g = l.shares * (l.close - l.fill_price);
    if (a.d >= l.lt_date) ult += g; else ust += g;
  }
  tax += pos(ust) * a.cfg.tax_rate_st + pos(ult) * a.cfg.tax_rate_lt;
  const ytd = byYear.get(year) ?? { st: 0, lt: 0 };
  const start = a.first ?? { strategy_value, spy: a.spy, mtum: a.mtum };
  const bench = (now: number | null, then: number | null) => (now != null && then ? start.strategy_value * (now / then) : null);
  return {
    d: a.d, b: a.b, invested, open_value, realized, cash, strategy_value,
    spy_value: bench(a.spy, start.spy), mtum_value: bench(a.mtum, start.mtum),
    realized_st_ytd: ytd.st, realized_lt_ytd: ytd.lt, tax_est: tax, after_tax_value: strategy_value - tax, vol_scale: a.m,
  };
}

const addMonths = (d: string, n: number) => {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCMonth(x.getUTCMonth() + n);
  return x.toISOString().slice(0, 10);
};

/** Return over the trailing `months` (null until the history covers it), for any value column. */
export function trailingReturn(rows: EquityRow[], months: number, key: "after_tax_value" | "strategy_value" | "spy_value" | "mtum_value") {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const from = addMonths(last.d, -months);
  if (rows[0].d > from) return null;
  const base = [...rows].reverse().find((r) => r.d <= from);
  const a = base?.[key], b = last[key];
  return a && b != null ? b / a - 1 : null;
}

export function tradeStats(closed: ClosedLotV[], rows: EquityRow[], t: string) {
  const n = closed.length;
  const wins = closed.filter((l) => (l.pnl ?? 0) > 0).length;
  const rs = closed.map((l) => l.r_multiple).filter((x): x is number => x != null);
  const days = closed.map((l) => l.days_held).filter((x): x is number => x != null);
  const yearAgo = addMonths(t, -12);
  const sold = closed.filter((l) => l.exit_date > yearAgo).reduce((s, l) => s + (l.exit_price ?? 0) * l.shares, 0);
  const recent = rows.filter((r) => r.d > yearAgo);
  const avg = recent.length ? recent.reduce((s, r) => s + r.strategy_value, 0) / recent.length : 0;
  return {
    trades: n,
    winRate: n ? wins / n : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    avgDaysHeld: days.length ? days.reduce((a, b) => a + b, 0) / days.length : null,
    turnover12m: avg > 0 ? sold / avg : null,
  };
}

/** Kill switch: with 12 months of history, the strategy's after-tax 12-month return trails MTUM. */
export function killSwitch(rows: EquityRow[]) {
  const mine = trailingReturn(rows, 12, "after_tax_value");
  const mtum = trailingReturn(rows, 12, "mtum_value");
  return { active: mine != null && mtum != null && mine < mtum, mine, mtum };
}

/** Idle cash: invested under half of I → suggest parking it in the cash ETF (informational). */
export function idleCash(investedValue: number, I: number) {
  return investedValue < 0.5 * I ? Math.max(0, I - investedValue) : 0;
}
