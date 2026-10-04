// bt — local backtests. Run `npm run bt -- help`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { prepare } from "./data/prepare.ts";
import { fetchReference } from "./data/fetch-ref.ts";
import { synth } from "./data/synth.ts";
import { ParquetSource } from "./data/store.ts";
import { STRATEGIES } from "./strategies/index.ts";
import { grid, runOne, statsLine, sweepCsv, writeRun, type RunSpec } from "./report.ts";
import type { Stats } from "./engine/metrics.ts";

const HELP = `bt — backtests on Massive flat files with the app's strategy rules

  bt synth      --out <dir> [--years 4] [--stocks 60]        synthetic flat files + reference (demo / tests)
  bt fetch-ref  --out <ref dir> [--details] [--rps 10]       reference data from Massive (needs MASSIVE_API_KEY)
  bt prepare    --flat <day_aggs dir> --ref <ref dir> --data <out dir> [--from YYYY-MM-DD] [--memory 8GB]
  bt list                                                    strategies and their parameters
  bt run        --data <dir> --strategy momentum [--from] [--to] [--capital 20000] [--set key=value ...]
                [--slippage-bps 10] [--commission 0] [--bench SPY,MTUM] [--tax 0.30,0.15] [--where "c >= 1"] [--out results]
  bt sweep      same as run, plus --grid key=v1,v2,... (repeatable); writes sweep.csv ranked by --sort (default sharpe)
`;

const coerce = (v: string): unknown => (v === "true" ? true : v === "false" ? false : v !== "" && Number.isFinite(Number(v)) ? Number(v) : v);
const kv = (list: string[] | undefined, split = false) => Object.fromEntries((list ?? []).map((s) => {
  const i = s.indexOf("=");
  if (i < 0) throw new Error(`Expected key=value, got "${s}"`);
  const k = s.slice(0, i), v = s.slice(i + 1);
  return [k, split ? v.split(",").map(coerce) : coerce(v)];
}));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: a } = parseArgs({
    args: rest, allowPositionals: true, options: {
      out: { type: "string" }, data: { type: "string" }, flat: { type: "string" }, ref: { type: "string" },
      from: { type: "string" }, to: { type: "string" }, years: { type: "string" }, stocks: { type: "string" },
      details: { type: "boolean" }, rps: { type: "string" }, memory: { type: "string" },
      strategy: { type: "string", default: "momentum" }, capital: { type: "string", default: "20000" },
      set: { type: "string", multiple: true }, grid: { type: "string", multiple: true },
      "slippage-bps": { type: "string", default: "10" }, commission: { type: "string", default: "0" },
      bench: { type: "string", default: "SPY,MTUM" }, tax: { type: "string", default: "0.30,0.15" },
      where: { type: "string" }, sort: { type: "string", default: "sharpe" }, name: { type: "string" },
    },
  });
  switch (cmd) {
    case "synth": {
      const r = synth({ out: resolve(a.out ?? "data/synth"), years: Number(a.years ?? 4), stocks: Number(a.stocks ?? 60) });
      console.log(`Synthetic market: ${r.tickers} tickers × ${r.days} days → ${a.out ?? "data/synth"}`);
      return;
    }
    case "fetch-ref":
      return fetchReference({ out: resolve(a.out ?? "data/ref"), details: a.details, rps: a.rps ? Number(a.rps) : undefined });
    case "prepare":
      if (!a.flat || !a.data) throw new Error("prepare needs --flat and --data");
      await prepare({ flat: resolve(a.flat), ref: a.ref ? resolve(a.ref) : undefined, out: resolve(a.data), from: a.from, to: a.to, memoryLimit: a.memory });
      return;
    case "list":
      for (const s of Object.values(STRATEGIES)) console.log(`${s.name.padEnd(12)} ${s.description}\n${" ".repeat(13)}defaults: ${JSON.stringify(s.defaults)}`);
      console.log("\nmomentum also takes every key of the app's settings (lib/momentum/config.ts MOM_DEFAULTS).");
      return;
    case "run":
    case "sweep": {
      if (!a.data) throw new Error(`${cmd} needs --data (a folder made by bt prepare)`);
      const data = await ParquetSource.open(resolve(a.data), { where: a.where });
      const days = data.days();
      const [st, lt] = a.tax.split(",").map(Number);
      const opt = { from: a.from ?? days[Math.min(days.length - 1, 260)], to: a.to ?? days[days.length - 1], capital: Number(a.capital),
        slippageBps: Number(a["slippage-bps"]), commission: Number(a.commission) };
      const base: RunSpec = { strategy: a.strategy, params: kv(a.set), opt, tax: { st, lt } };
      const outRoot = resolve(a.out ?? "results");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const bench: Record<string, Stats> = {};
      for (const t of a.bench.split(",").filter(Boolean)) {
        try {
          bench[t] = (await runOne(data, { strategy: "buyhold", params: { ticker: t }, opt, tax: base.tax })).stats;
        } catch (e) {
          console.warn(`Benchmark ${t} skipped: ${String(e)}`);
        }
      }
      console.log(`${opt.from} → ${opt.to}, capital $${opt.capital.toLocaleString()}, slippage ${opt.slippageBps} bps`);
      for (const [t, s] of Object.entries(bench)) console.log(statsLine(`${t} (buy & hold)`, s));
      if (cmd === "run") {
        const r = await runOne(data, base);
        const dir = join(outRoot, a.name ?? `${stamp}-${a.strategy}`);
        writeRun(dir, base, r, bench);
        console.log(statsLine(a.strategy, r.stats));
        console.log(`Results: ${dir}`);
      } else {
        const combos = grid(kv(a.grid, true) as Record<string, unknown[]>);
        const rows: { params: Record<string, unknown>; stats: Stats }[] = [];
        const dir = join(outRoot, a.name ?? `${stamp}-sweep-${a.strategy}`);
        mkdirSync(dir, { recursive: true });
        for (const [k, g] of combos.entries()) {
          const spec = { ...base, params: { ...base.params, ...g } };
          const r = await runOne(data, spec);
          writeRun(join(dir, `run-${String(k + 1).padStart(3, "0")}`), spec, r, bench);
          rows.push({ params: g, stats: r.stats });
          console.log(statsLine(`#${k + 1} ${JSON.stringify(g)}`.slice(0, 22), r.stats));
        }
        const key = a.sort as keyof Stats;
        rows.sort((x, y) => (Number(y.stats[key] ?? -Infinity) - Number(x.stats[key] ?? -Infinity)));
        writeFileSync(join(dir, "sweep.csv"), sweepCsv(rows));
        console.log(`Sweep (${rows.length} runs, sorted by ${a.sort}): ${join(dir, "sweep.csv")}`);
      }
      data.close();
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.stack ?? e.message : e));
  process.exit(1);
});
