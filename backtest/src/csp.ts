// Cash-secured put timing study: would selling a ~0.25-delta put on rs_rsi2 signal days have been
// safer than on other days for the same kind of stock? For each entry (a stock-day), at that day's
// close: strike = close × exp(−z × σ × √(T/252)) with σ the annualized realized volatility of the last
// `vol_days` daily log returns (z = 0.67 ≈ 0.25 delta, T = `days`). `days` sessions later: assigned if
// that close is under the strike; outcome = (close − strike) ÷ strike (negative = loss beyond the
// strike; premium not included). A stock that stops trading counts at its last close.
//
// Groups (all with the rs_rsi2 liquidity filter, close under `max_price`, SPY above its 200-day):
//   signal   — rs_rsi2 entry signals that day (its own settings, e.g. max_atr_pct 0.06)
//   baseline — other stock-days in the top 20% by RS and above their 200-day (same ATR cap unless
//              baseline_max_atr_pct says otherwise), i.e. the same kind of stock without the RSI(2) dip
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isMonthEnd, isWeekEnd, type Calendar } from "../../lib/momentum/calendar.ts";
import type { Ctx, DataSource } from "./engine/engine.ts";
import { Portfolio } from "./engine/portfolio.ts";
import type { Row } from "./engine/types.ts";
import { relativeStrength, rsRsi2, Tape } from "./strategies/signals.ts";
import { percentile } from "./batch.ts";

export type CspSpec = {
  /** rs_rsi2 settings for the signal (and the filters both groups share). */
  params?: Record<string, unknown>;
  max_price?: number; days?: number; vol_days?: number; z?: number;
  /** ATR ÷ close cap for the baseline; defaults to the signal's max_atr_pct (null = no cap). */
  baseline_max_atr_pct?: number | null;
};
type Acc = { n: number; assigned: number; lossSum: number; outcomes: number[] };
export type CspRow = { group: "signal" | "baseline"; year: string; entries: number; assignment_rate: number | null; avg_loss_when_assigned: number | null;
  p5_outcome: number | null; worst5_avg_outcome: number | null; median_outcome: number | null };

const optNum = (v: unknown) => (v == null || v === "" || v === "null" || !Number.isFinite(Number(v)) ? null : Number(v));

export async function runCsp(data: DataSource, from: string, to: string, spec: CspSpec, log: (s: string) => void = () => {}, onProgress?: (d: number, t: number) => void) {
  const params = { ...rsRsi2.defaults, ...(spec.params ?? {}) } as typeof rsRsi2.defaults;
  const maxPrice = spec.max_price ?? 50, T = spec.days ?? 21, volDays = spec.vol_days ?? 30, z = spec.z ?? 0.67;
  const sigAtr = optNum(params.max_atr_pct);
  const baseAtr = spec.baseline_max_atr_pct === undefined ? sigAtr : optNum(spec.baseline_max_atr_pct);
  const all = data.days();
  const startIdx = all.findIndex((d) => d >= from);
  let endIdx = -1;
  for (let j = 0; j < all.length; j++) if (all[j] <= to) endIdx = j;
  if (startIdx < 0 || endIdx < startIdx) throw new Error(`No trading days between ${from} and ${to}`);
  const warmup = typeof rsRsi2.warmupDays === "function" ? rsRsi2.warmupDays(params) : rsRsi2.warmupDays;
  const firstIdx = Math.max(0, startIdx - Math.max(warmup, volDays + 5));
  const lastIdx = Math.min(all.length - 1, endIdx + T);
  const cal: Calendar = { traded: all, holidays: new Set() };
  const tickers = data.tickers();
  // The signal: rs_rsi2 itself, run with an empty portfolio that never fills (every buy = a signal).
  const strat = rsRsi2.create(params, { capital: 100_000, shared: new Map() });
  const pf = new Portfolio(100_000);
  // Our own per-ticker history for the baseline rules (RS, 200-day average, ATR, realized volatility).
  const N = Math.max(params.trend_ma, params.from_days + 1, params.market_ma, volDays + 1, params.atr_period + 1, params.dollar_vol_lookback) + 2;
  const tapes = new Map<string, { t: Tape; sums: number[] }>();
  const lens = [params.trend_ma, params.market_ma];
  const sma = (x: { t: Tape; sums: number[] }, k: number) => (x.t.n >= lens[k] ? x.sums[k] / lens[k] : NaN);
  const last = new Map<string, number>();
  type Entry = { g: "signal" | "baseline"; year: string; strike: number; t: string; d: string; close: number; sigma: number };
  const exits = new Map<number, Entry[]>();
  /** Every signal entry with its numbers (the baseline is too large to list). */
  const signalEntries: (Entry & { close_after: number; outcome: number; assigned: boolean })[] = [];
  const acc = new Map<string, Acc>();
  const A = (g: string, y: string) => { const k = `${g}|${y}`; let a = acc.get(k); if (!a) acc.set(k, (a = { n: 0, assigned: 0, lossSum: 0, outcomes: [] })); return a; };
  let noVol = 0;

  let loaded = new Map<string, Map<string, Row>>();
  let loadedTo = -1;
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (onProgress && (i - firstIdx) % 20 === 0) onProgress(i - firstIdx, lastIdx - firstIdx + 1);
    if (i > loadedTo) { const t2 = Math.min(lastIdx, i + 20); loaded = await data.rows(all[i], all[t2]); loadedTo = t2; }
    const d = all[i];
    const today = loaded.get(d) ?? new Map<string, Row>();
    for (const [t, r] of today) {
      last.set(t, r.c);
      let x = tapes.get(t);
      if (!x) tapes.set(t, (x = { t: new Tape(N), sums: lens.map(() => 0) }));
      x.t.push(r);
      lens.forEach((L, k) => { x!.sums[k] += r.c; if (x!.t.n > L) x!.sums[k] -= x!.t.close(L); });
    }
    // Outcomes due today (T sessions after entry).
    for (const e of exits.get(i) ?? []) {
      const c = last.get(e.t);
      if (c == null) continue;
      const out = (c - e.strike) / e.strike, a = A(e.g, e.year);
      a.n++; a.outcomes.push(out);
      if (e.g === "signal") signalEntries.push({ ...e, close_after: c, outcome: out, assigned: c < e.strike });
      if (c < e.strike) { a.assigned++; a.lossSum += out; }
    }
    exits.delete(i);
    if (i > endIdx) continue;

    const trading = i >= startIdx;
    const ctx: Ctx = { d, i, days: all, cal, trading, today, row: (t) => today.get(t), lastClose: (t) => today.get(t)?.c ?? last.get(t), portfolio: pf,
      equity: pf.cash, tickers, isMonthEnd: isMonthEnd(cal, d), isWeekEnd: isWeekEnd(cal, d) };
    const signals = new Set(strat.onClose(ctx).filter((o) => o.side === "buy").map((o) => o.ticker));
    if (!trading || i + T > lastIdx) continue;
    // Market filter (both groups): SPY above its 200-day average.
    const m = tapes.get(params.market_ticker), mr = today.get(params.market_ticker);
    if (params.use_market_filter && (!m || !mr || !(mr.c > sma(m, 1)))) continue;
    // Liquid universe (as rs_rsi2), then RS percentile among it.
    const liquid: { r: Row; t: Tape; x: { t: Tape; sums: number[] } }[] = [];
    for (const r of today.values()) {
      if (r.ticker === params.market_ticker || r.c < params.min_price) continue;
      if (params.common_only) { const type = tickers.get(r.ticker)?.type; if (type && type !== "CS") continue; }
      const x = tapes.get(r.ticker)!;
      if (!(x.t.mean("dv", params.dollar_vol_lookback) >= params.min_avg_dollar_vol)) continue;
      liquid.push({ r, t: x.t, x });
    }
    const year = d.slice(0, 4);
    const enter = (g: "signal" | "baseline", r: Row, t: Tape) => {
      const sigma = realizedVol(t, volDays);
      if (!Number.isFinite(sigma)) { noVol++; return; }
      const strike = r.c * Math.exp(-z * sigma * Math.sqrt(T / 252));
      const k = i + T;
      const list = exits.get(k) ?? [];
      list.push({ g, year, strike, t: r.ticker, d, close: r.c, sigma });
      exits.set(k, list);
    };
    for (const { x, pct } of relativeStrength(liquid, params.from_days, params.skip_days)) {
      const r = x.r;
      if (r.c >= maxPrice) continue;
      if (signals.has(r.ticker)) { enter("signal", r, x.t); continue; }
      if (pct <= 1 - params.top_pct || !(r.c > sma(x.x, 0))) continue;
      if (baseAtr != null && !(x.t.atr(params.atr_period) / r.c <= baseAtr)) continue;
      enter("baseline", r, x.t);
    }
  }

  const rowOf = (g: "signal" | "baseline", year: string, a: Acc): CspRow => {
    const o = [...a.outcomes].sort((p, q) => p - q), k = Math.max(1, Math.ceil(o.length * 0.05));
    return {
      group: g, year, entries: a.n, assignment_rate: a.n ? a.assigned / a.n : null, avg_loss_when_assigned: a.assigned ? a.lossSum / a.assigned : null,
      p5_outcome: percentile(o, 0.05), worst5_avg_outcome: o.length ? o.slice(0, k).reduce((s, v) => s + v, 0) / k : null, median_outcome: percentile(o, 0.5),
    };
  };
  const rows: CspRow[] = [];
  for (const g of ["signal", "baseline"] as const) {
    const ys = [...acc.keys()].filter((k) => k.startsWith(`${g}|`)).map((k) => k.split("|")[1]).sort();
    const tot: Acc = { n: 0, assigned: 0, lossSum: 0, outcomes: [] };
    for (const y of ys) {
      const a = acc.get(`${g}|${y}`)!;
      rows.push(rowOf(g, y, a));
      tot.n += a.n; tot.assigned += a.assigned; tot.lossSum += a.lossSum; for (const v of a.outcomes) tot.outcomes.push(v);
    }
    rows.push(rowOf(g, "All", tot));
  }
  if (noVol) log(`${noVol} entries skipped for lack of ${volDays} days of returns.`);
  signalEntries.sort((a, b) => a.d.localeCompare(b.d) || a.t.localeCompare(b.t));
  return { rows, signalEntries, from: all[startIdx], to: all[endIdx], settings: { max_price: maxPrice, days: T, vol_days: volDays, z, signal_max_atr_pct: sigAtr, baseline_max_atr_pct: baseAtr } };
}

/** Annualized standard deviation of the last `n` daily log returns (needs n + 1 closes). */
export function realizedVol(t: Tape, n: number) {
  if (t.n < n + 1) return NaN;
  const r: number[] = [];
  for (let k = 0; k < n; k++) r.push(Math.log(t.close(k) / t.close(k + 1)));
  const m = r.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) * Math.sqrt(252);
}

const f = (x: number | null, k = 6) => (x == null ? "" : String(+x.toFixed(k)));
export function cspCsv(rows: CspRow[]) {
  return ["group,year,entries,assignment_rate,avg_loss_when_assigned,p5_outcome,worst5_avg_outcome,median_outcome",
    ...rows.map((r) => [r.group, r.year, r.entries, f(r.assignment_rate), f(r.avg_loss_when_assigned), f(r.p5_outcome), f(r.worst5_avg_outcome), f(r.median_outcome)].join(","))].join("\n") + "\n";
}
export function cspTable(rows: CspRow[]) {
  const p = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`).padStart(8);
  return ["Group     Year  Entries  Assigned  AvgLoss  Worst5%p  Worst5%avg",
    ...rows.map((r) => `${r.group.padEnd(9)} ${r.year.padEnd(5)} ${String(r.entries).padStart(7)}  ${p(r.assignment_rate)} ${p(r.avg_loss_when_assigned)} ${p(r.p5_outcome)}   ${p(r.worst5_avg_outcome)}`)].join("\n");
}

export function writeCsp(dir: string, name: string, res: Awaited<ReturnType<typeof runCsp>>, spec: CspSpec) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `csp-${name}.csv`);
  writeFileSync(file, cspCsv(res.rows));
  writeFileSync(join(dir, `csp-${name}-signals.csv`), ["date,ticker,close,sigma,strike,close_after,outcome,assigned",
    ...res.signalEntries.map((e) => [e.d, e.t, f(e.close, 4), f(e.sigma), f(e.strike, 4), f(e.close_after, 4), f(e.outcome), e.assigned].join(","))].join("\n") + "\n");
  writeFileSync(join(dir, `csp-${name}.json`), JSON.stringify({ created: new Date().toISOString(), from: res.from, to: res.to, spec, settings: res.settings, rows: res.rows }, null, 2));
  return file;
}
