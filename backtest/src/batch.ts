// Batches: any list of strategy runs (one run, a sweep, or several strategies picked in the app)
// over the same period and costs, with SPY / MTUM style benchmarks run once per batch.
// Layout: <results>/<stamp>-<name>/
//   batch.json, batch.csv          spec + one row of stats per run
//   bench-<TICKER>/                benchmark summary.json + equity.csv
//   run-001-<label>/               summary.json, equity.csv, trades.csv, fills.csv
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBacktestMany, type DataSource } from "./engine/engine.ts";
import { STRATEGIES } from "./strategies/index.ts";
import type { Stats, TaxRates } from "./engine/metrics.ts";
import { grid, runOne, statsOf, sweepCsv, writeRun, type RunSpec } from "./report.ts";

export type BatchRun = {
  label?: string; strategy: string; params?: Record<string, unknown>;
  /** "sectors": run only when the data has SIC codes (Download reference with details); otherwise skipped with a note. */
  requires?: "sectors";
};
export type BatchSpec = {
  name?: string;
  from?: string;
  to?: string;
  capital?: number;
  slippageBps?: number;
  commission?: number;
  tax?: TaxRates;
  bench?: string[];
  runs?: BatchRun[];
  /**
   * Seed sweep: every group runs once per seed (params + {[seedParam]: seed}), all in one pass over
   * the data. Writes montecarlo-<name>.csv (5th / 50th / 95th percentiles per group and the share of
   * seeds beating the benchmark's CAGR) and montecarlo-<name>-runs.csv (one line per seed).
   */
  montecarlo?: { seeds: number[] | { from: number; to: number }; seedParam?: string; benchmark?: string; groups: BatchRun[] };
  /**
   * Parameter neighborhood: one run per combination of `axes` on top of `params`, all in one pass
   * over the data. Writes <output>-<name>.csv (default "grid"): one row per run (the axis values,
   * CAGR, max drawdown, end value) and a summary (median CAGR, runs with CAGR above `beat`).
   */
  grid?: { strategy: string; params?: Record<string, unknown>; axes: Record<string, unknown[]>; beat?: number; output?: string };
};
export type BatchEvent =
  | { type: "start"; dir: string; runs: number }
  | { type: "progress"; run: number; runs: number; label: string; done: number; total: number }
  | { type: "result"; run: number; label: string; dir: string; stats: Stats }
  | { type: "log"; text: string }
  | { type: "done"; dir: string };

// Folder and file names: letters, digits, "-" and "_" only, kept short (Windows rejects some characters and long paths).
const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "") || "run";

/** Write one run's folder; a failure is logged and the batch carries on (its stats are already in batch.csv). */
function safeWriteRun(emit: (e: BatchEvent) => void, ...args: Parameters<typeof writeRun>) {
  try {
    writeRun(...args);
    return true;
  } catch (e) {
    emit({ type: "log", text: `Couldn't write the folder ${args[0]}: ${String(e instanceof Error ? e.message : e)} (the run's results are still in batch.csv).` });
    return false;
  }
}

/** Label for a run: its name if given, else strategy plus the parameters that differ from defaults. */
export const runLabel = (r: BatchRun) =>
  r.label ?? [r.strategy, ...Object.entries(r.params ?? {}).map(([k, v]) => `${k}=${v}`)].join(" ");

/** Linear-interpolated percentile (like numpy's default) of unsorted values. */
export function percentile(values: number[], q: number) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export async function runBatch(data: DataSource, spec: BatchSpec, resultsDir: string, emit: (e: BatchEvent) => void = () => {}) {
  if (spec.montecarlo) return runMonteCarlo(data, spec, resultsDir, emit);
  if (spec.grid) return runGrid(data, spec, resultsDir, emit);
  const runList = spec.runs ?? [];
  const days = data.days();
  if (!days.length) throw new Error("The data set has no trading days");
  const from = spec.from ?? days[Math.min(days.length - 1, 260)];
  const to = spec.to ?? days[days.length - 1];
  const opt = { from, to, capital: spec.capital ?? 20_000, slippageBps: spec.slippageBps ?? 10, commission: spec.commission ?? 0 };
  const tax = spec.tax ?? { st: 0.3, lt: 0.15 };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(resultsDir, `${stamp}-${slug(spec.name ?? (runList.length === 1 ? runLabel(runList[0]) : `batch-${runList.length}`))}`);
  mkdirSync(dir, { recursive: true });
  emit({ type: "start", dir, runs: runList.length });

  const bench: Record<string, Stats> = {};
  for (const t of spec.bench ?? ["SPY", "MTUM"]) {
    try {
      const b = await runOne(data, { strategy: "buyhold", params: { ticker: t }, opt, tax });
      bench[t] = b.stats;
      safeWriteRun(emit, join(dir, `bench-${slug(t)}`), { strategy: "buyhold", params: { ticker: t }, opt, tax }, b, {});
      emit({ type: "log", text: `Benchmark ${t}: CAGR ${(b.stats.cagr * 100).toFixed(1)}%` });
    } catch (e) {
      emit({ type: "log", text: `Benchmark ${t} skipped: ${String(e instanceof Error ? e.message : e)}` });
    }
  }

  const rows: { folder: string; label: string; strategy: string; params: Record<string, unknown>; stats: Stats }[] = [];
  const hasSectors = [...data.tickers().values()].some((t) => !!t.sic_code);
  for (const [k, r] of runList.entries()) {
    const label = runLabel(r);
    if (r.requires === "sectors" && !hasSectors) {
      emit({ type: "log", text: `Skipped "${label}": the data has no sector (SIC) codes. Download reference data with ticker details, run Prepare again, then rerun this batch.` });
      continue;
    }
    const runSpec: RunSpec = { strategy: r.strategy, params: r.params ?? {}, opt: { ...opt, onProgress: (done, total) => emit({ type: "progress", run: k + 1, runs: runList.length, label, done, total }) }, tax };
    const res = await runOne(data, runSpec);
    const folder = `run-${String(k + 1).padStart(3, "0")}-${slug(label)}`;
    safeWriteRun(emit, join(dir, folder), { ...runSpec, opt }, res, bench, label);
    rows.push({ folder, label, strategy: r.strategy, params: r.params ?? {}, stats: res.stats });
    emit({ type: "result", run: k + 1, label, dir: join(dir, folder), stats: res.stats });
  }
  const json = JSON.stringify({ name: spec.name ?? null, created: new Date().toISOString(), spec: { ...spec, from, to }, benchmarks: bench, runs: rows }, null, 2);
  const csv = sweepCsv(rows.map((x) => ({ params: { label: x.label, strategy: x.strategy, ...x.params }, stats: x.stats })));
  writeFileSync(join(dir, "batch.json"), json);
  writeFileSync(join(dir, "batch.csv"), csv);
  // A named batch also gets batch-<name>.json / .csv, easy to find and share.
  if (spec.name) { writeFileSync(join(dir, `batch-${slug(spec.name)}.json`), json); writeFileSync(join(dir, `batch-${slug(spec.name)}.csv`), csv); }
  emit({ type: "done", dir });
  return { dir, rows, bench };
}

type PassRun = { label: string; strategy: string; params: Record<string, unknown>; group?: string; seed?: number };
type PassRow = { folder: string; label: string; strategy: string; params: Record<string, unknown>; stats: Stats; group?: string; seed?: number };

/** Benchmarks, then every run in one pass over the data; writes run folders, batch.json and batch.csv. */
async function runOnePass(data: DataSource, spec: BatchSpec, resultsDir: string, emit: (e: BatchEvent) => void, runs: PassRun[], benchFirst: string | null, what: string) {
  const days = data.days();
  if (!days.length) throw new Error("The data set has no trading days");
  const from = spec.from ?? days[Math.min(days.length - 1, 260)];
  const to = spec.to ?? days[days.length - 1];
  const opt = { from, to, capital: spec.capital ?? 20_000, slippageBps: spec.slippageBps ?? 10, commission: spec.commission ?? 0 };
  const tax = spec.tax ?? { st: 0.3, lt: 0.15 };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = spec.name ?? what;
  const dir = join(resultsDir, `${stamp}-${slug(name)}`);
  mkdirSync(dir, { recursive: true });
  emit({ type: "start", dir, runs: runs.length });

  const bench: Record<string, Stats> = {};
  for (const t of [...new Set([...(benchFirst ? [benchFirst] : []), ...(spec.bench ?? [])])]) {
    try {
      const b = await runOne(data, { strategy: "buyhold", params: { ticker: t }, opt, tax });
      bench[t] = b.stats;
      safeWriteRun(emit, join(dir, `bench-${slug(t)}`), { strategy: "buyhold", params: { ticker: t }, opt, tax }, b, {});
      emit({ type: "log", text: `Benchmark ${t}: CAGR ${(b.stats.cagr * 100).toFixed(1)}%` });
    } catch (e) {
      emit({ type: "log", text: `Benchmark ${t} skipped: ${String(e instanceof Error ? e.message : e)}` });
    }
  }
  emit({ type: "log", text: `${runs.length} runs (${what}) in one pass over the data…` });
  const results = await runBacktestMany(data, runs.map((r) => {
    const def = STRATEGIES[r.strategy];
    if (!def) throw new Error(`Unknown strategy "${r.strategy}"`);
    return { def, params: r.params };
  }), { ...opt, onProgress: (done, total) => emit({ type: "progress", run: 1, runs: 1, label: `${runs.length} runs`, done, total }) });

  const rows: PassRow[] = results.map((res, k) => {
    const r = runs[k], stats = statsOf(res, tax);
    return { folder: `run-${String(k + 1).padStart(3, "0")}-${slug(r.label)}`, label: r.label, strategy: r.strategy, params: r.params, stats, group: r.group, seed: r.seed };
  });
  const json = JSON.stringify({ name, created: new Date().toISOString(), spec: { ...spec, from, to }, benchmarks: bench, runs: rows.map(({ group: _g, seed: _s, ...x }) => x) }, null, 2);
  writeFileSync(join(dir, "batch.json"), json);
  writeFileSync(join(dir, "batch.csv"), sweepCsv(rows.map((x) => ({ params: { label: x.label, strategy: x.strategy, ...x.params }, stats: x.stats }))));
  /** Per-run folders (equity, trades, fills): written after the summary files, failures logged. */
  const writeFolders = () => {
    let failed = 0;
    rows.forEach((row, k) => {
      if (!safeWriteRun(emit, join(dir, row.folder), { strategy: row.strategy, params: row.params, opt, tax }, { result: results[k], stats: row.stats }, bench, row.label)) failed++;
    });
    if (failed) emit({ type: "log", text: `${failed} of ${rows.length} run folders couldn't be written; the summary files are complete.` });
  };
  return { dir, rows, bench, name, writeFolders };
}

async function runGrid(data: DataSource, spec: BatchSpec, resultsDir: string, emit: (e: BatchEvent) => void) {
  const g = spec.grid!;
  const keys = Object.keys(g.axes);
  const combos = grid(g.axes as Record<string, unknown[]>);
  const show = (v: unknown) => (v === null ? "null" : String(v));
  const runs: PassRun[] = combos.map((c) => ({ label: keys.map((k) => `${k}=${show(c[k])}`).join(" "), strategy: g.strategy, params: { ...(g.params ?? {}), ...c } }));
  const { dir, rows, bench, name, writeFolders } = await runOnePass(data, spec, resultsDir, emit, runs, null, `${combos.length} combinations`);
  const beat = g.beat ?? 0;
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const f = (x: number | null | undefined, k = 6) => (x == null || !Number.isFinite(x) ? "" : String(+x.toFixed(k)));
  const lines = [["run", ...keys, "cagr", "max_drawdown", "end_value"].join(",")];
  rows.forEach((r, k) => lines.push([esc(r.label), ...keys.map((x) => show(combos[k][x])), f(r.stats.cagr), f(r.stats.maxDrawdown), f(r.stats.endValue, 2)].join(",")));
  const cagrs = rows.map((r) => r.stats.cagr);
  const med = percentile(cagrs, 0.5), above = cagrs.filter((c) => c > beat).length;
  lines.push("", "summary,value", `runs,${rows.length}`, `median_cagr,${f(med)}`, `runs_with_cagr_above_${f(beat * 100, 2)}pct,${above}`,
    `share_above_${f(beat * 100, 2)}pct,${f(above / rows.length, 4)}`);
  for (const [t, st] of Object.entries(bench)) lines.push(`${t}_cagr,${f(st.cagr)}`);
  const file = `${g.output ?? "grid"}-${slug(name)}.csv`;
  writeFileSync(join(dir, file), lines.join("\n") + "\n");
  const pc = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  for (const r of rows) emit({ type: "log", text: `${r.label}: CAGR ${pc(r.stats.cagr)}, max drawdown ${pc(r.stats.maxDrawdown)}, end value $${Math.round(r.stats.endValue).toLocaleString()}` });
  emit({ type: "log", text: `Median CAGR across ${rows.length} runs: ${pc(med)}; ${above} of ${rows.length} beat ${pc(beat)}. Saved ${file}.` });
  writeFolders();
  emit({ type: "done", dir });
  return { dir, rows, bench };
}

async function runMonteCarlo(data: DataSource, spec: BatchSpec, resultsDir: string, emit: (e: BatchEvent) => void) {
  const mc = spec.montecarlo!;
  const range = mc.seeds as { from: number; to: number };
  const seeds = Array.isArray(mc.seeds) ? mc.seeds : Array.from({ length: range.to - range.from + 1 }, (_, k) => range.from + k);
  const seedParam = mc.seedParam ?? "seed";
  const benchT = mc.benchmark ?? spec.bench?.[0] ?? "SPY";
  const runs: PassRun[] = mc.groups.flatMap((g) => seeds.map((seed) => ({ group: runLabel(g), seed, strategy: g.strategy, label: `${runLabel(g)} seed ${seed}`, params: { ...(g.params ?? {}), [seedParam]: seed } })));
  const { dir, rows, bench, name, writeFolders } = await runOnePass(data, spec, resultsDir, emit, runs, benchT, `${mc.groups.length} configs × ${seeds.length} seeds`);
  const bc = bench[benchT]?.cagr ?? null;
  const q = (xs: number[]) => [percentile(xs, 0.05), percentile(xs, 0.5), percentile(xs, 0.95)];
  const f = (x: number | null) => (x == null ? "" : String(+x.toFixed(6)));
  const summary = ["config,seeds,cagr_p5,cagr_median,cagr_p95,max_drawdown_p5,max_drawdown_median,max_drawdown_p95,end_value_p5,end_value_median,end_value_p95,pct_beat_benchmark,benchmark,benchmark_cagr"];
  for (const g of mc.groups) {
    const gr = rows.filter((x) => x.group === runLabel(g));
    const cagr = gr.map((x) => x.stats.cagr), dd = gr.map((x) => x.stats.maxDrawdown), ev = gr.map((x) => x.stats.endValue);
    const beat = bc == null ? null : gr.filter((x) => x.stats.cagr > bc).length / gr.length;
    summary.push([JSON.stringify(runLabel(g)), gr.length, ...q(cagr).map(f), ...q(dd).map(f), ...q(ev).map((x) => (x == null ? "" : x.toFixed(2))), f(beat), benchT, f(bc)].join(","));
    const pc = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
    const [c5, c50, c95] = q(cagr), [d5, d50, d95] = q(dd), [e5, e50, e95] = q(ev);
    emit({ type: "log", text: `${runLabel(g)}: CAGR ${pc(c5)} / ${pc(c50)} / ${pc(c95)} (5th / median / 95th), max drawdown ${pc(d5)} / ${pc(d50)} / ${pc(d95)}, ` +
      `end value $${Math.round(e5 ?? 0).toLocaleString()} / $${Math.round(e50 ?? 0).toLocaleString()} / $${Math.round(e95 ?? 0).toLocaleString()}, ` +
      `${beat == null ? "no benchmark" : `${(beat * 100).toFixed(0)}% of seeds beat ${benchT}'s ${pc(bc)}`}` });
  }
  const sumCsv = summary.join("\n") + "\n";
  writeFileSync(join(dir, `montecarlo-${slug(name)}.csv`), sumCsv);
  writeFileSync(join(dir, `montecarlo-${slug(name)}-runs.csv`), sweepCsv(rows.map((x) => ({ params: { config: x.group, seed: x.seed }, stats: x.stats }))));
  writeFolders();
  emit({ type: "done", dir });
  return { dir, rows, bench };
}
