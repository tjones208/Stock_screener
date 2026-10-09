// Run a strategy (plus benchmarks) and write results; grid sweeps over parameters.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBacktest, type DataSource, type RunOptions, type RunResult } from "./engine/engine.ts";
import { computeStats, type Stats, type TaxRates } from "./engine/metrics.ts";
import { STRATEGIES } from "./strategies/index.ts";

export type RunSpec = { strategy: string; params: Record<string, unknown>; opt: RunOptions; tax?: TaxRates };

export async function runOne(data: DataSource, spec: RunSpec): Promise<{ result: RunResult; stats: Stats }> {
  const def = STRATEGIES[spec.strategy];
  if (!def) throw new Error(`Unknown strategy "${spec.strategy}". Known: ${Object.keys(STRATEGIES).join(", ")}`);
  const result = await runBacktest(data, def, spec.params, spec.opt);
  const unrealized = result.open.reduce((a, l) => a + l.shares * ((result.finalPrices[l.ticker] ?? l.price) - l.price), 0);
  const stats = computeStats(result.equity, result.closed, { dividends: result.dividendsByYear, tax: spec.tax, unrealizedGain: unrealized });
  return { result, stats };
}

const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => (v == null ? "" : typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
};

export function writeRun(dir: string, spec: RunSpec, r: { result: RunResult; stats: Stats }, bench: Record<string, Stats>, label?: string) {
  mkdirSync(dir, { recursive: true });
  const { onProgress: _p, ...options } = spec.opt;
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ label: label ?? spec.strategy, strategy: spec.strategy, params: spec.params, options, tax: spec.tax, stats: r.stats, benchmarks: bench,
    dividends: r.result.dividends, commissions: r.result.commissions, unfilledOrders: r.result.unfilled,
    openPositions: r.result.open.map((l) => ({ ticker: l.ticker, shares: l.shares, entry: l.price, d: l.d })) }, null, 2));
  writeFileSync(join(dir, "equity.csv"), csv(r.result.equity));
  writeFileSync(join(dir, "trades.csv"), csv(r.result.closed));
  writeFileSync(join(dir, "fills.csv"), csv(r.result.fills));
}

const pct = (x: number | null | undefined, k = 1) => (x == null ? "—" : `${(x * 100).toFixed(k)}%`);
const num = (x: number | null | undefined, k = 2) => (x == null ? "—" : x.toFixed(k));

export function statsLine(name: string, s: Stats) {
  return `${name.padEnd(22)} CAGR ${pct(s.cagr).padStart(7)}  after-tax ${pct(s.afterTaxCagr).padStart(7)}  maxDD ${pct(s.maxDrawdown).padStart(7)}  Sharpe ${num(s.sharpe).padStart(5)}  vol ${pct(s.volatility).padStart(6)}  trades ${String(s.trades).padStart(5)}  win ${pct(s.winRate, 0).padStart(4)}  turnover ${num(s.turnover, 1)}×`;
}

/** Cartesian product of grid values. */
export function grid(g: Record<string, unknown[]>): Record<string, unknown>[] {
  return Object.entries(g).reduce<Record<string, unknown>[]>((acc, [k, vals]) => acc.flatMap((a) => vals.map((v) => ({ ...a, [k]: v }))), [{}]);
}

export function sweepCsv(rows: { params: Record<string, unknown>; stats: Stats }[]) {
  // Every run's parameters get a column (runs can set different ones), then the stats.
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.params)))];
  return csv(rows.map((r) => ({
    ...Object.fromEntries(keys.map((k) => [k, k in r.params ? (r.params[k] === null ? "null" : r.params[k]) : ""])), cagr: r.stats.cagr, after_tax_cagr: r.stats.afterTaxCagr, max_drawdown: r.stats.maxDrawdown, sharpe: r.stats.sharpe,
    sortino: r.stats.sortino, volatility: r.stats.volatility, calmar: r.stats.calmar, trades: r.stats.trades, win_rate: r.stats.winRate,
    turnover: r.stats.turnover, exposure: r.stats.exposure, end_value: r.stats.endValue,
  })));
}
