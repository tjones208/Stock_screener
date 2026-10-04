// Batches: any list of strategy runs (one run, a sweep, or several strategies picked in the app)
// over the same period and costs, with SPY / MTUM style benchmarks run once per batch.
// Layout: <results>/<stamp>-<name>/
//   batch.json, batch.csv          spec + one row of stats per run
//   bench-<TICKER>/                benchmark summary.json + equity.csv
//   run-001-<label>/               summary.json, equity.csv, trades.csv, fills.csv
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DataSource } from "./engine/engine.ts";
import type { Stats, TaxRates } from "./engine/metrics.ts";
import { runOne, sweepCsv, writeRun, type RunSpec } from "./report.ts";

export type BatchRun = { label?: string; strategy: string; params?: Record<string, unknown> };
export type BatchSpec = {
  name?: string;
  from?: string;
  to?: string;
  capital?: number;
  slippageBps?: number;
  commission?: number;
  tax?: TaxRates;
  bench?: string[];
  runs: BatchRun[];
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

export async function runBatch(data: DataSource, spec: BatchSpec, resultsDir: string, emit: (e: BatchEvent) => void = () => {}) {
  const days = data.days();
  if (!days.length) throw new Error("The data set has no trading days");
  const from = spec.from ?? days[Math.min(days.length - 1, 260)];
  const to = spec.to ?? days[days.length - 1];
  const opt = { from, to, capital: spec.capital ?? 20_000, slippageBps: spec.slippageBps ?? 10, commission: spec.commission ?? 0 };
  const tax = spec.tax ?? { st: 0.3, lt: 0.15 };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(resultsDir, `${stamp}-${slug(spec.name ?? (spec.runs.length === 1 ? runLabel(spec.runs[0]) : `batch-${spec.runs.length}`))}`);
  mkdirSync(dir, { recursive: true });
  emit({ type: "start", dir, runs: spec.runs.length });

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
  for (const [k, r] of spec.runs.entries()) {
    const label = runLabel(r);
    const runSpec: RunSpec = { strategy: r.strategy, params: r.params ?? {}, opt: { ...opt, onProgress: (done, total) => emit({ type: "progress", run: k + 1, runs: spec.runs.length, label, done, total }) }, tax };
    const res = await runOne(data, runSpec);
    const folder = `run-${String(k + 1).padStart(3, "0")}-${slug(label)}`;
    writeRun(join(dir, folder), { ...runSpec, opt }, res, bench, label);
    rows.push({ folder, label, strategy: r.strategy, params: r.params ?? {}, stats: res.stats });
    emit({ type: "result", run: k + 1, label, dir: join(dir, folder), stats: res.stats });
  }
  writeFileSync(join(dir, "batch.json"), JSON.stringify({ name: spec.name ?? null, created: new Date().toISOString(), spec: { ...spec, from, to }, benchmarks: bench, runs: rows }, null, 2));
  writeFileSync(join(dir, "batch.csv"), sweepCsv(rows.map((x) => ({ params: { label: x.label, strategy: x.strategy, ...x.params }, stats: x.stats }))));
  emit({ type: "done", dir });
  return { dir, rows, bench };
}
