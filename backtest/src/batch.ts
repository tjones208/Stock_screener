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
import { runOne, statsOf, sweepCsv, writeRun, type RunSpec } from "./report.ts";

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
};
export type BatchEvent =
  | { type: "start"; dir: string; runs: number }
  | { type: "progress"; run: number; runs: number; label: string; done: number; total: number }
  | { type: "result"; run: number; label: string; dir: string; stats: Stats }
  | { type: "log"; text: string }
  | { type: "done"; dir: string };

const slug = (s: string) => s.replace(/[^A-Za-z0-9_.=-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "run";

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
      writeRun(join(dir, `bench-${slug(t)}`), { strategy: "buyhold", params: { ticker: t }, opt, tax }, b, {});
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
    writeRun(join(dir, folder), { ...runSpec, opt }, res, bench, label);
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

async function runMonteCarlo(data: DataSource, spec: BatchSpec, resultsDir: string, emit: (e: BatchEvent) => void) {
  const mc = spec.montecarlo!;
  const days = data.days();
  if (!days.length) throw new Error("The data set has no trading days");
  const from = spec.from ?? days[Math.min(days.length - 1, 260)];
  const to = spec.to ?? days[days.length - 1];
  const opt = { from, to, capital: spec.capital ?? 20_000, slippageBps: spec.slippageBps ?? 10, commission: spec.commission ?? 0 };
  const tax = spec.tax ?? { st: 0.3, lt: 0.15 };
  const range = mc.seeds as { from: number; to: number };
  const seeds = Array.isArray(mc.seeds) ? mc.seeds : Array.from({ length: range.to - range.from + 1 }, (_, k) => range.from + k);
  const seedParam = mc.seedParam ?? "seed";
  const benchT = mc.benchmark ?? spec.bench?.[0] ?? "SPY";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = spec.name ?? "montecarlo";
  const dir = join(resultsDir, `${stamp}-${slug(name)}`);
  mkdirSync(dir, { recursive: true });
  const runs = mc.groups.flatMap((g) => seeds.map((seed) => ({ group: g, seed, label: `${runLabel(g)} seed ${seed}`, params: { ...(g.params ?? {}), [seedParam]: seed } })));
  emit({ type: "start", dir, runs: runs.length });

  const bench: Record<string, Stats> = {};
  for (const t of [...new Set([benchT, ...(spec.bench ?? [])])]) {
    try {
      const b = await runOne(data, { strategy: "buyhold", params: { ticker: t }, opt, tax });
      bench[t] = b.stats;
      writeRun(join(dir, `bench-${slug(t)}`), { strategy: "buyhold", params: { ticker: t }, opt, tax }, b, {});
      emit({ type: "log", text: `Benchmark ${t}: CAGR ${(b.stats.cagr * 100).toFixed(1)}%` });
    } catch (e) {
      emit({ type: "log", text: `Benchmark ${t} skipped: ${String(e instanceof Error ? e.message : e)}` });
    }
  }
  emit({ type: "log", text: `${runs.length} runs (${mc.groups.length} configs × ${seeds.length} seeds) in one pass over the data…` });
  const results = await runBacktestMany(data, runs.map((r) => {
    const def = STRATEGIES[r.group.strategy];
    if (!def) throw new Error(`Unknown strategy "${r.group.strategy}"`);
    return { def, params: r.params };
  }), { ...opt, onProgress: (done, total) => emit({ type: "progress", run: 1, runs: 1, label: `${runs.length} seed runs`, done, total }) });

  const rows: { folder: string; label: string; strategy: string; params: Record<string, unknown>; stats: Stats; group: string; seed: number }[] = [];
  results.forEach((res, k) => {
    const r = runs[k], stats = statsOf(res, tax);
    const folder = `run-${String(k + 1).padStart(3, "0")}-${slug(r.label)}`;
    writeRun(join(dir, folder), { strategy: r.group.strategy, params: r.params, opt, tax }, { result: res, stats }, bench, r.label);
    rows.push({ folder, label: r.label, strategy: r.group.strategy, params: r.params, stats, group: runLabel(r.group), seed: r.seed });
  });

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
  const json = JSON.stringify({ name, created: new Date().toISOString(), spec: { ...spec, from, to }, benchmarks: bench, runs: rows.map(({ group: _g, seed: _s, ...x }) => x) }, null, 2);
  writeFileSync(join(dir, "batch.json"), json);
  writeFileSync(join(dir, "batch.csv"), sweepCsv(rows.map((x) => ({ params: { label: x.label, strategy: x.strategy, ...x.params }, stats: x.stats }))));
  emit({ type: "done", dir });
  return { dir, rows, bench };
}
