// bt — local backtests. Run `npm run bt -- help`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { prepare } from "./data/prepare.ts";
import { convert } from "./data/convert.ts";
import { fetchReference } from "./data/fetch-ref.ts";
import { synth } from "./data/synth.ts";
import { ParquetSource } from "./data/store.ts";
import { loadStrategies } from "./strategies/index.ts";
import { grid, statsLine } from "./report.ts";
import { runBatch, type BatchEvent, type BatchSpec } from "./batch.ts";
import { loadEnv } from "./env.ts";
import { runStudy, studyTable, writeStudy } from "./study.ts";

const HELP = `bt — backtests on Massive flat files with the app's strategy rules

  bt app                                                     open the backtest app in your browser
  bt synth      --out <dir> [--years 4] [--stocks 60]        synthetic flat files + reference (demo / tests)
  bt convert    --src <flat-file dir> --dest <parquet dir> [--group auto|month|day] [--force]
                                                             any Massive flat files (*.csv.gz) → Parquet; incremental
  bt fetch-ref  --out <ref dir> [--details] [--rps 10]       reference data from Massive (needs MASSIVE_API_KEY)
  bt prepare    --flat <day_aggs dir or its parquet copy> --ref <ref dir> --data <out dir> [--from YYYY-MM-DD] [--memory 8GB]
  bt list                                                    strategies and their parameters
  bt run        --data <dir> --strategy momentum [--from] [--to] [--capital 20000] [--set key=value ...]
                [--slippage-bps 10] [--commission 0] [--bench SPY,MTUM] [--tax 0.30,0.15] [--where "c >= 1"] [--out results]
  bt sweep      same as run, plus --grid key=v1,v2,... (repeatable)
  bt batch      --data <dir> --spec batch.json [--out results]   several strategies / settings in one batch
  bt study      --data <dir> --strategy pullback [--from] [--to] [--horizons 5,10,15] [--set key=value ...] [--out results]
                every signal's forward return vs the strategy's universe on the same days, by year
  Add --events to print progress as JSON lines (used by the app).
`;

const coerce = (v: string): unknown => (v === "true" ? true : v === "false" ? false : v !== "" && Number.isFinite(Number(v)) ? Number(v) : v);
const kv = (list: string[] | undefined, split = false) => Object.fromEntries((list ?? []).map((s) => {
  const i = s.indexOf("=");
  if (i < 0) throw new Error(`Expected key=value, got "${s}"`);
  const k = s.slice(0, i), v = s.slice(i + 1);
  return [k, split ? v.split(",").map(coerce) : coerce(v)];
}));

async function main() {
  loadEnv();
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
      where: { type: "string" }, name: { type: "string" }, spec: { type: "string" }, horizons: { type: "string" },
      src: { type: "string" }, dest: { type: "string" }, group: { type: "string" }, force: { type: "boolean" },
      events: { type: "boolean" }, port: { type: "string" }, "no-open": { type: "boolean" },
    },
  });
  // --events: one JSON object per line on stdout (the app parses them); otherwise readable text.
  const ev = (e: BatchEvent | { type: "progress"; label: string; done: number; total: number }) => {
    if (a.events) { process.stdout.write(JSON.stringify(e) + "\n"); return; }
    if (e.type === "log") console.log(e.text);
    else if (e.type === "result") console.log(statsLine(e.label.slice(0, 22), e.stats));
    else if (e.type === "done") console.log(`Results: ${e.dir}`);
  };
  const log = (text: string) => ev({ type: "log", text });
  const progress = (done: number, total: number, label: string) => a.events && ev({ type: "progress", label, done, total });

  switch (cmd) {
    case "app": {
      const { startServer } = await import("./server/server.ts");
      await startServer({ port: a.port ? Number(a.port) : undefined, open: !a["no-open"] });
      return;
    }
    case "synth": {
      const r = synth({ out: resolve(a.out ?? "data/synth"), years: Number(a.years ?? 4), stocks: Number(a.stocks ?? 60) });
      log(`Synthetic market: ${r.tickers} tickers × ${r.days} days → ${resolve(a.out ?? "data/synth")}`);
      return;
    }
    case "convert":
      if (!a.src || !a.dest) throw new Error("convert needs --src and --dest");
      await convert({ src: resolve(a.src), dest: resolve(a.dest), group: (a.group as "auto" | "month" | "day") ?? "auto", force: a.force, memoryLimit: a.memory, log, onProgress: progress });
      return;
    case "fetch-ref":
      return fetchReference({ out: resolve(a.out ?? "data/ref"), details: a.details, rps: a.rps ? Number(a.rps) : undefined, log });
    case "prepare":
      if (!a.flat || !a.data) throw new Error("prepare needs --flat and --data");
      await prepare({ flat: resolve(a.flat), ref: a.ref ? resolve(a.ref) : undefined, out: resolve(a.data), from: a.from, to: a.to, memoryLimit: a.memory, log, onProgress: progress });
      return;
    case "list": {
      const { strategies, sources, errors } = await loadStrategies();
      for (const s of Object.values(strategies)) console.log(`${s.name.padEnd(18)} [${sources[s.name] ?? "?"}] ${s.description}`);
      for (const e of errors) console.log(`! ${e.file}: ${e.error}`);
      console.log("\nmomentum takes every key of the app's settings (lib/momentum/config.ts MOM_DEFAULTS).");
      return;
    }
    case "run":
    case "sweep":
    case "batch": {
      if (!a.data) throw new Error(`${cmd} needs --data (a folder made by bt prepare)`);
      const { errors } = await loadStrategies();
      for (const e of errors) log(`Strategy file ${e.file} not loaded: ${e.error}`);
      const [st, lt] = a.tax.split(",").map(Number);
      const base = { from: a.from, to: a.to, capital: Number(a.capital), slippageBps: Number(a["slippage-bps"]), commission: Number(a.commission), tax: { st, lt }, bench: a.bench.split(",").filter(Boolean) };
      const spec: BatchSpec = cmd === "batch"
        ? { ...base, ...(JSON.parse(readFileSync(resolve(a.spec ?? "batch.json"), "utf8")) as BatchSpec) }
        : { ...base, name: a.name, runs: (cmd === "run" ? [{}] : grid(kv(a.grid, true) as Record<string, unknown[]>)).map((g) => ({ strategy: a.strategy, params: { ...kv(a.set), ...g }, label: cmd === "run" ? a.name : undefined })) };
      const data = await ParquetSource.open(resolve(a.data), { where: a.where });
      try {
        const r = await runBatch(data, spec, resolve(a.out ?? "results"), ev);
        if (!a.events) for (const [t, s] of Object.entries(r.bench)) console.log(statsLine(`${t} (buy & hold)`, s));
      } finally {
        data.close();
      }
      return;
    }
    case "study": {
      if (!a.data) throw new Error("study needs --data (a folder made by bt prepare)");
      const { strategies, errors } = await loadStrategies();
      for (const e of errors) log(`Strategy file ${e.file} not loaded: ${e.error}`);
      const def = strategies[a.strategy];
      if (!def) throw new Error(`Unknown strategy "${a.strategy}"`);
      const horizons = (a.horizons ?? "5,10,15").split(",").map(Number).filter((x) => x > 0);
      const data = await ParquetSource.open(resolve(a.data), { where: a.where });
      try {
        const params = kv(a.set);
        log(`Signal study: ${def.name}${Object.keys(params).length ? ` (${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}, ${a.from ?? "start"} → ${a.to ?? "end"}, horizons ${horizons.join("/")} sessions`);
        const { result, signals } = await runStudy(data, def, { strategy: def.name, params, from: a.from, to: a.to, horizons, name: a.name },
          (done, total) => progress(done, total, "Scanning days"));
        const dir = writeStudy(resolve(a.out ?? "results"), result, signals);
        for (const line of studyTable(result).split("\n")) log(line);
        log(`Signals without a next-day bar: ${result.noEntry.signals}; past the end of the data: ${result.incomplete}.`);
        ev({ type: "done", dir });
      } finally {
        data.close();
      }
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  const msg = String(e instanceof Error ? e.stack ?? e.message : e);
  if (process.argv.includes("--events")) process.stdout.write(JSON.stringify({ type: "error", text: msg }) + "\n");
  console.error(msg);
  process.exit(1);
});
