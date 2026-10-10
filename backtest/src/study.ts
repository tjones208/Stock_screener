// Signal study: every entry signal a strategy gives (filled or not), and its forward return N
// sessions after the next day's open, against every stock in the strategy's universe on the same
// days. The strategy runs day by day with an empty portfolio that never fills, so every buy it
// asks for is a signal; its `universe(ctx)` (if any) is the baseline, else every stock with a bar.
//
// Return over N sessions = close of the Nth session counting the entry day ÷ the entry day's open − 1
// (5 sessions: next open → close 4 sessions later; same counting as a 5-day time stop). Prices are
// split-adjusted, dividends left out. `cost` (default 0.20%) is subtracted from each signal's return
// for the cost-adjusted columns (round-trip slippage); the universe has no cost. A stock that stops
// trading uses its last close. Layout: <results>/studies/<stamp>-<name>/ study.json, study.csv, signals.csv.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMonthEnd, isWeekEnd, type Calendar } from "../../lib/momentum/calendar.ts";
import type { Ctx, DataSource, StrategyDef } from "./engine/engine.ts";
import { Portfolio } from "./engine/portfolio.ts";
import type { Row } from "./engine/types.ts";

export type StudySpec = { strategy: string; params?: Record<string, unknown>; from?: string; to?: string; horizons?: number[]; name?: string; cost?: number; batch?: string };

type Acc = { n: number[]; sum: number[]; pos: number[]; posNet: number[] };
const acc = (k: number): Acc => ({ n: Array(k).fill(0), sum: Array(k).fill(0), pos: Array(k).fill(0), posNet: Array(k).fill(0) });
export type Item = { t: string; sig: boolean; year: string; d: string; entry: number; r: (number | null)[] };

export type StudyRow = {
  year: string; signals: number; signalDays: number; baseline: number;
  sig: (number | null)[]; base: (number | null)[]; edge: (number | null)[]; sigWin: (number | null)[]; baseWin: (number | null)[];
  /** Signal return minus the cost, and that minus the universe. */
  net: (number | null)[]; netEdge: (number | null)[]; netWin: (number | null)[];
  /** More groups (e.g. the earnings study's bottom 10% and all events): count, average return, share positive. */
  extra?: Record<string, { n: number; avg: (number | null)[]; win: (number | null)[] }>;
};
export type StudyResult = {
  name: string; strategy: string; params: Record<string, unknown>; from: string; to: string; horizons: number[]; created: string; cost: number; batch: string | null;
  rows: StudyRow[]; noEntry: { signals: number; baseline: number }; incomplete: number;
};

export async function runStudy(data: DataSource, def: StrategyDef, spec: StudySpec, onProgress?: (done: number, total: number) => void) {
  const cost = spec.cost ?? 0.002;
  const H = [...new Set((spec.horizons?.length ? spec.horizons : def.studyHorizons ?? [5, 10, 15]).map((x) => Math.max(1, Math.round(x))))].sort((a, b) => a - b);
  const maxH = H.at(-1)!;
  const all = data.days();
  if (!all.length) throw new Error("The data set has no trading days");
  const from = spec.from || all[Math.min(all.length - 1, 260)];
  const to = spec.to || all.at(-1)!;
  const startIdx = all.findIndex((d) => d >= from);
  let endIdx = -1;
  for (let j = 0; j < all.length; j++) if (all[j] <= to) endIdx = j;
  if (startIdx < 0 || endIdx < startIdx) throw new Error(`No trading days between ${from} and ${to}`);
  const params = { ...def.defaults, ...(spec.params ?? {}) };
  const warmup = typeof def.warmupDays === "function" ? def.warmupDays(params) : def.warmupDays;
  const firstIdx = Math.max(0, startIdx - warmup);
  const lastIdx = Math.min(all.length - 1, endIdx + maxH); // forward returns read past `to`
  const cal: Calendar = { traded: all, holidays: new Set() };
  const strat = def.create(params, { capital: 100_000 });
  const pf = new Portfolio(100_000);
  const tickers = data.tickers();

  const last = new Map<string, number>();
  const entering = new Map<number, Item[]>();   // day index → items entering at that open
  const exiting = new Map<number, { it: Item; h: number }[]>(); // day index → horizon exits at that close
  const groups = new Map<string, { sig: Acc; base: Acc; signals: number; days: number; baseline: number }>();
  const group = (y: string) => {
    let g = groups.get(y);
    if (!g) groups.set(y, (g = { sig: acc(H.length), base: acc(H.length), signals: 0, days: 0, baseline: 0 }));
    return g;
  };
  const signalItems: Item[] = [];
  const noEntry = { signals: 0, baseline: 0 };
  let incomplete = 0;
  const push = <T,>(m: Map<number, T[]>, k: number, v: T) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };

  let loaded = new Map<string, Map<string, Row>>();
  let loadedTo = -1;
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (onProgress && (i - firstIdx) % 20 === 0) onProgress(i - firstIdx, lastIdx - firstIdx + 1);
    if (i > loadedTo) {
      const t = Math.min(lastIdx, i + 20);
      loaded = await data.rows(all[i], all[t]);
      loadedTo = t;
    }
    const d = all[i];
    const today = loaded.get(d) ?? new Map<string, Row>();
    for (const [t, r] of today) last.set(t, r.c);

    // Entries at today's open, then exits at today's close (a 1-session hold exits the same day).
    for (const it of entering.get(i) ?? []) {
      const bar = today.get(it.t);
      if (!bar || !(bar.o > 0)) { it.sig ? noEntry.signals++ : noEntry.baseline++; continue; }
      it.entry = bar.o;
      H.forEach((h, k) => (i + h - 1 <= lastIdx && i + h - 1 < all.length ? push(exiting, i + h - 1, { it, h: k }) : incomplete++));
    }
    entering.delete(i);
    for (const { it, h } of exiting.get(i) ?? []) {
      const r = (last.get(it.t) ?? it.entry) / it.entry - 1;
      it.r[h] = r;
      const g = group(it.year), a = it.sig ? g.sig : g.base;
      a.n[h]++; a.sum[h] += r; if (r > 0) a.pos[h]++; if (r - cost > 0) a.posNet[h]++;
    }
    exiting.delete(i);

    if (i > endIdx) continue;
    const ctx: Ctx = {
      d, i, days: all, cal, trading: i >= startIdx, today, row: (t) => today.get(t), lastClose: (t) => today.get(t)?.c ?? last.get(t), portfolio: pf,
      equity: pf.cash, tickers, isMonthEnd: isMonthEnd(cal, d), isWeekEnd: isWeekEnd(cal, d),
    };
    const orders = strat.onClose(ctx);
    if (!ctx.trading || i + 1 > lastIdx) continue;
    const sigs = [...new Set(orders.filter((o) => o.side === "buy").map((o) => o.ticker))];
    if (!sigs.length) continue;
    const year = d.slice(0, 4), g = group(year);
    g.signals += sigs.length; g.days++;
    for (const t of sigs) {
      const it: Item = { t, sig: true, year, d, entry: NaN, r: H.map(() => null) };
      signalItems.push(it);
      push(entering, i + 1, it);
    }
    const uni = strat.universe?.(ctx) ?? [...today.keys()];
    g.baseline += uni.length;
    for (const t of uni) push(entering, i + 1, { t, sig: false, year, d, entry: NaN, r: H.map(() => null) });
  }

  const avg = (a: Acc, k: number) => (a.n[k] ? a.sum[k] / a.n[k] : null);
  const win = (a: Acc, k: number) => (a.n[k] ? a.pos[k] / a.n[k] : null);
  const rowOf = (year: string, gs: NonNullable<ReturnType<typeof groups.get>>[]): StudyRow => {
    const sum = (f: (x: (typeof gs)[number]) => Acc) => {
      const a = acc(H.length);
      for (const x of gs) for (let k = 0; k < H.length; k++) { a.n[k] += f(x).n[k]; a.sum[k] += f(x).sum[k]; a.pos[k] += f(x).pos[k]; a.posNet[k] += f(x).posNet[k]; }
      return a;
    };
    const s = sum((x) => x.sig), b = sum((x) => x.base);
    const sig = H.map((_, k) => avg(s, k)), base = H.map((_, k) => avg(b, k));
    const net = sig.map((x) => (x == null ? null : x - cost));
    return {
      year, signals: gs.reduce((a, x) => a + x.signals, 0), signalDays: gs.reduce((a, x) => a + x.days, 0), baseline: gs.reduce((a, x) => a + x.baseline, 0),
      sig, base, edge: H.map((_, k) => (sig[k] != null && base[k] != null ? sig[k]! - base[k]! : null)),
      sigWin: H.map((_, k) => win(s, k)), baseWin: H.map((_, k) => win(b, k)),
      net, netEdge: H.map((_, k) => (net[k] != null && base[k] != null ? net[k]! - base[k]! : null)),
      netWin: H.map((_, k) => (s.n[k] ? s.posNet[k] / s.n[k] : null)),
    };
  };
  const years = [...groups.keys()].sort();
  const result: StudyResult = {
    name: spec.name ?? `${def.name} signal study`, strategy: def.name, params: spec.params ?? {}, from: all[startIdx], to: all[endIdx], horizons: H,
    created: new Date().toISOString(), cost, batch: spec.batch ?? null, rows: [...years.map((y) => rowOf(y, [groups.get(y)!])), rowOf("All", years.map((y) => groups.get(y)!))],
    noEntry, incomplete,
  };
  return { result, signals: signalItems };
}

const f = (x: number | null, k = 2) => (x == null ? "" : (x * 100).toFixed(k));

export function studyCsv(r: StudyResult) {
  const H = r.horizons;
  const extraKeys = [...new Set(r.rows.flatMap((x) => Object.keys(x.extra ?? {})))];
  const head = ["year", "signals", "signal_days", "baseline_stock_days",
    ...H.map((h) => `signal_${h}d_pct`), ...H.map((h) => `baseline_${h}d_pct`), ...H.map((h) => `edge_${h}d_pct`),
    ...H.map((h) => `signal_${h}d_win_pct`), ...H.map((h) => `baseline_${h}d_win_pct`),
    ...H.map((h) => `cost_adjusted_${h}d_pct`), ...H.map((h) => `edge_after_cost_${h}d_pct`), ...H.map((h) => `cost_adjusted_${h}d_win_pct`),
    ...extraKeys.flatMap((g) => [`${g}_n`, ...H.map((h) => `${g}_${h}d_pct`), ...H.map((h) => `${g}_${h}d_win_pct`)])];
  return [head.join(","), ...r.rows.map((x) => [x.year, x.signals, x.signalDays, x.baseline,
    ...x.sig.map((v) => f(v, 3)), ...x.base.map((v) => f(v, 3)), ...x.edge.map((v) => f(v, 3)), ...x.sigWin.map((v) => f(v, 1)), ...x.baseWin.map((v) => f(v, 1)),
    ...x.net.map((v) => f(v, 3)), ...x.netEdge.map((v) => f(v, 3)), ...x.netWin.map((v) => f(v, 1)),
    ...extraKeys.flatMap((g) => { const e = x.extra?.[g]; return [e?.n ?? "", ...H.map((_, k) => f(e?.avg[k] ?? null, 3)), ...H.map((_, k) => f(e?.win[k] ?? null, 1))]; })].join(","))].join("\n") + "\n";
}

/** One CSV for a batch: the all-years row of each study, one line per horizon. */
export function batchSummaryCsv(items: { name: string; result: StudyResult }[]) {
  const lines = ["study,strategy,horizon_days,signals,signal_days,signal_pct,cost_adjusted_pct,universe_pct,edge_pct,edge_after_cost_pct,signal_win_pct,cost_adjusted_win_pct,universe_win_pct"];
  for (const { name, result: r } of items) {
    const x = r.rows.at(-1)!;
    r.horizons.forEach((h, k) => lines.push([JSON.stringify(name), r.strategy, h, x.signals, x.signalDays, f(x.sig[k], 3), f(x.net[k], 3), f(x.base[k], 3), f(x.edge[k], 3), f(x.netEdge[k], 3),
      f(x.sigWin[k], 1), f(x.netWin[k], 1), f(x.baseWin[k], 1)].join(",")));
  }
  return lines.join("\n") + "\n";
}

/** Plain-text table for the console and the job log. */
export function studyTable(r: StudyResult) {
  const H = r.horizons;
  const p = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`).padStart(8);
  const head = `${"Year".padEnd(5)} ${"Signals".padStart(7)}  ${H.map((h) => `Sig ${h}d`.padStart(8)).join(" ")}  ${H.map((h) => `Base ${h}d`.padStart(8)).join(" ")}  ${H.map((h) => `Edge ${h}d`.padStart(8)).join(" ")}  ${H.map((h) => `Net ${h}d`.padStart(8)).join(" ")}  ${H.map((h) => `NetEdge${h}`.padStart(9)).join(" ")}`;
  return [head, ...r.rows.map((x) => `${x.year.padEnd(5)} ${String(x.signals).padStart(7)}  ${x.sig.map(p).join(" ")}  ${x.base.map(p).join(" ")}  ${x.edge.map(p).join(" ")}  ${x.net.map(p).join(" ")}  ${x.netEdge.map((v) => p(v).padStart(9)).join(" ")}`),
    `Net = signal return minus ${(r.cost * 100).toFixed(2)}% cost; NetEdge = Net minus the universe.`,
    ...[...new Set(r.rows.flatMap((x) => Object.keys(x.extra ?? {})))].flatMap((g) => [`${g}:`,
      ...r.rows.map((x) => `${x.year.padEnd(5)} ${String(x.extra?.[g]?.n ?? 0).padStart(7)}  ${(x.extra?.[g]?.avg ?? []).map(p).join(" ")}`)])].join("\n");
}

// Folder names: letters, digits, "-" and "_" only, kept short (Windows rejects some characters and long paths).
const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "") || "study";

export function writeStudy(resultsDir: string, r: StudyResult, signals: Item[]) {
  const stamp = r.created.replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(resultsDir, "studies", `${stamp}-${slug(r.name)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "study.json"), JSON.stringify(r, null, 2));
  writeFileSync(join(dir, "study.csv"), studyCsv(r));
  writeFileSync(join(dir, "signals.csv"), ["date,ticker,entry_open," + r.horizons.map((h) => `ret_${h}d`).join(","),
    ...signals.map((s) => [s.d, s.t, Number.isFinite(s.entry) ? s.entry.toFixed(4) : "", ...s.r.map((v) => (v == null ? "" : v.toFixed(5)))].join(","))].join("\n") + "\n");
  return dir;
}
