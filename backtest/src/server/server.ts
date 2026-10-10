// The backtest app: a local web server (127.0.0.1 only) and a single-page UI in ./public.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { BT_ROOT, loadEnv, saveEnv } from "../env.ts";
import { loadStrategies } from "../strategies/index.ts";
import { JobQueue, type Job } from "./jobs.ts";
import { Duck, lit } from "../data/duck.ts";
import { listFlatFiles } from "../data/convert.ts";

const PUBLIC = join(BT_ROOT, "src", "server", "public");
// Where the app keeps your folder choices and presets (overridable for tests).
let SETTINGS = join(BT_ROOT, "app-settings.json");
let PRESETS = join(BT_ROOT, "presets.json");

type Settings = {
  folders: { dayCsv: string; minuteCsv: string; dayParquet: string; minuteParquet: string; ref: string; data: string; results: string };
  run: { from: string; to: string; capital: number; slippageBps: number; commission: number; taxSt: number; taxLt: number; bench: string };
  prepare: { from: string; memory: string };
};
type Preset = { id: string; name: string; strategy: string; params: Record<string, unknown>; sweep?: Record<string, string> };

const defaults = (): Settings => ({
  folders: { dayCsv: "", minuteCsv: "", dayParquet: "", minuteParquet: "", ref: "", data: join(BT_ROOT, "data", "bt"), results: join(BT_ROOT, "results") },
  run: { from: "", to: "", capital: 20000, slippageBps: 10, commission: 0, taxSt: 0.3, taxLt: 0.15, bench: "SPY,MTUM" },
  prepare: { from: "", memory: "8GB" },
});
const readJson = <T>(f: string, fallback: T): T => { try { return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback; } catch { return fallback; } };
/**
 * A pasted folder path, cleaned: surrounding spaces and quotes removed (Windows' "Copy as path"
 * adds quotes), trailing slashes dropped.
 */
export const cleanPath = (p: unknown) => String(p ?? "").trim().replace(/^["']+|["']+$/g, "").trim().replace(/(?<=[^:\\/])[\\/]+$/, ""); // keeps a drive root ("D:\\") and "/"
const cleanFolders = (f: Partial<Settings["folders"]> = {}) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, cleanPath(v)])) as Partial<Settings["folders"]>;

const loadSettings = (): Settings => {
  const s = readJson<Partial<Settings>>(SETTINGS, {});
  const d = defaults();
  return { folders: { ...d.folders, ...cleanFolders(s.folders) }, run: { ...d.run, ...s.run }, prepare: { ...d.prepare, ...s.prepare } };
};

function send(res: ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as string | Buffer));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const c of req) s += c;
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}
const inside = (root: string, p: string) => {
  const r = relative(resolve(root), resolve(p));
  return !!r && !r.startsWith("..") && !r.includes(`..${sep}`) && !resolve(p).startsWith(sep + sep);
};

/** Thin equity curve for charts: at most `max` points, always keeping the last. */
function thin<T>(rows: T[], max = 1500) {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let k = 0; k < max; k++) out.push(rows[Math.floor(k * step)]);
  out.push(rows[rows.length - 1]);
  return out;
}
function readCsv(file: string, limit = Infinity) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = lines[0]?.split(",") ?? [];
  const num = (v: string) => (v !== "" && Number.isFinite(Number(v)) ? Number(v) : v === "true" ? true : v === "false" ? false : v);
  return lines.slice(1, Number.isFinite(limit) ? limit + 1 : undefined).map((l) => {
    const vals = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? [];
    return Object.fromEntries(cols.map((c, k) => [c, num(vals[k] ?? "")]));
  });
}

async function dataStatus(dir: string) {
  if (!dir || !existsSync(join(dir, "calendar.parquet"))) return { ready: false };
  const db = await Duck.open();
  try {
    const [c] = await db.all<{ d0: string; d1: string; n: number }>(`select min(d) d0, max(d) d1, count(*)::integer n from read_parquet(${lit(join(dir, "calendar.parquet"))})`);
    const [t] = await db.all<{ n: number; cs: number; inactive: number }>(`select count(*)::integer n, count(*) filter (where type = 'CS')::integer cs, count(*) filter (where not active)::integer inactive from read_parquet(${lit(join(dir, "tickers.parquet"))})`);
    const years = existsSync(join(dir, "daily")) ? readdirSync(join(dir, "daily")).filter((y) => y.startsWith("year=")).map((y) => y.slice(5)).sort() : [];
    return { ready: years.length > 0, from: c.d0, to: c.d1, days: c.n, tickers: t.n, common: t.cs, delisted: t.inactive, years };
  } finally {
    db.close();
  }
}

function folderInfo(p: string) {
  if (!p) return { exists: false };
  if (!existsSync(p)) return { exists: false };
  if (!statSync(p).isDirectory()) return { exists: true, isDir: false };
  const csv = (() => { try { return listFlatFiles(p); } catch { return []; } })();
  let parquet = 0;
  const walk = (d: string, depth = 0) => {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; } // e.g. protected system folders
    for (const e of entries) { if (e.isDirectory() && !e.name.startsWith(".")) walk(join(d, e.name), depth + 1); else if (e.name.endsWith(".parquet")) parquet++; }
  };
  walk(p);
  const ref = ["tickers.jsonl", "splits.jsonl", "dividends.jsonl", "details.jsonl"].filter((f) => existsSync(join(p, f)));
  const backtests = readdirSync(p).filter((x) => existsSync(join(p, x, "batch.json"))).length;
  return { exists: true, isDir: true, backtests, csvFiles: csv.length, firstDay: csv[0]?.d ?? null, lastDay: csv.at(-1)?.d ?? null, gb: +(csv.reduce((a, f) => a + f.size, 0) / 1e9).toFixed(2), parquetFiles: parquet, refFiles: ref, prepared: existsSync(join(p, "calendar.parquet")) };
}

/** Saved batch specs: backtest/batches/*.json ({name, from, to, capital, slippageBps, bench, runs}). */
const BATCHES = join(BT_ROOT, "batches");
function savedBatches() {
  if (!existsSync(BATCHES)) return [];
  return readdirSync(BATCHES).filter((f) => f.endsWith(".json")).sort().map((file) => {
    const b = readJson<{ name?: string; from?: string; to?: string; capital?: number; slippageBps?: number; bench?: string[]; runs?: { label?: string; strategy: string }[];
      montecarlo?: { seeds: number[] | { from: number; to: number }; groups: { label?: string; strategy: string }[] } } | null>(join(BATCHES, file), null);
    if (b?.montecarlo && Array.isArray(b.montecarlo.groups)) {
      const s = b.montecarlo.seeds, n = Array.isArray(s) ? s.length : s.to - s.from + 1;
      b.runs = b.montecarlo.groups.map((g) => ({ strategy: g.strategy, label: `${g.label ?? g.strategy} × ${n} seeds` }));
    }
    return b && Array.isArray(b.runs)
      ? { file, name: b.name ?? file.replace(/\.json$/, ""), from: b.from ?? null, to: b.to ?? null, capital: b.capital ?? null, slippageBps: b.slippageBps ?? null, bench: b.bench ?? [],
          runs: b.runs.map((r) => r.label ?? r.strategy) }
      : { file, error: "Not a batch file (needs a runs list)." };
  });
}

/** Results folder → batches (newest first). */
function listResults(root: string) {
  if (!existsSync(root)) return [];
  const out: unknown[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (name.startsWith(".") || !statSync(dir).isDirectory()) continue;
    const b = readJson<{ name: string | null; created: string; spec: { from: string; to: string; capital: number }; runs: { label: string; strategy: string; stats: Record<string, number> }[]; benchmarks: Record<string, Record<string, number>> } | null>(join(dir, "batch.json"), null);
    if (!b) continue;
    const best = [...b.runs].sort((x, y) => (y.stats.sharpe ?? -9) - (x.stats.sharpe ?? -9))[0];
    out.push({ dir: name, name: b.name, created: b.created, from: b.spec.from, to: b.spec.to, capital: b.spec.capital, runs: b.runs.length,
      strategies: [...new Set(b.runs.map((r) => r.strategy))], best: best ? { label: best.label, cagr: best.stats.cagr, sharpe: best.stats.sharpe, maxDrawdown: best.stats.maxDrawdown } : null,
      spyCagr: b.benchmarks?.SPY?.cagr ?? null });
  }
  return out.sort((a, b) => String((b as { created: string }).created).localeCompare(String((a as { created: string }).created)));
}

function openInOs(target: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
}

/** Errors go to the console and to backtest/backtester.log, and the app keeps running. */
function logError(where: string, e: unknown) {
  const text = `${new Date().toISOString()} ${where}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`;
  console.error(text.trim());
  try { appendFileSync(join(BT_ROOT, "backtester.log"), text); } catch { /* ignore */ }
}

export async function startServer(o: { port?: number; open?: boolean; host?: string; configDir?: string } = {}) {
  loadEnv();
  if (!process.listenerCount("uncaughtException")) {
    process.on("uncaughtException", (e) => logError("uncaught error", e));
    process.on("unhandledRejection", (e) => logError("unhandled rejection", e));
  }
  if (o.configDir) {
    SETTINGS = join(o.configDir, "app-settings.json");
    PRESETS = join(o.configDir, "presets.json");
  }
  let lib = await loadStrategies();
  const queue = new JobQueue(async (job: Job) => {
    if (job.kind === "demo" && job.status === "done") {
      const s = loadSettings();
      s.folders.data = join(BT_ROOT, "data", "demo", "data");
      writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
    }
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      if (req.method === "GET" && !p.startsWith("/api/")) {
        const file = join(PUBLIC, p === "/" ? "index.html" : p.slice(1));
        if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, "Not found", "text/plain");
        const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
        return send(res, 200, readFileSync(file), types[extname(file)] ?? "application/octet-stream");
      }
      const settings = loadSettings();

      if (p === "/api/state" && req.method === "GET") {
        return send(res, 200, {
          settings, presets: readJson<Preset[]>(PRESETS, []), keySet: !!process.env.MASSIVE_API_KEY, node: process.version, platform: process.platform,
          strategies: Object.values(lib.strategies).map((s) => ({ name: s.name, description: s.description, defaults: s.defaults, fields: s.fields ?? null, studyHorizons: s.studyHorizons ?? null, source: lib.sources[s.name] ?? "?" })),
          strategyErrors: lib.errors, data: await dataStatus(settings.folders.data), jobs: queue.jobs.map((j) => ({ ...j, log: j.log.slice(-200) })),
          strategyFolder: join(BT_ROOT, "strategies"), batches: savedBatches(), batchFolder: BATCHES,
        });
      }
      if (p === "/api/settings" && req.method === "POST") {
        const b = (await body(req)) as Partial<Settings>;
        const next: Settings = { folders: { ...settings.folders, ...cleanFolders(b.folders) }, run: { ...settings.run, ...b.run }, prepare: { ...settings.prepare, ...b.prepare } };
        writeFileSync(SETTINGS, JSON.stringify(next, null, 2));
        return send(res, 200, next);
      }
      if (p === "/api/key" && req.method === "POST") {
        const k = String((await body(req)).key ?? "").trim();
        if (!/^[A-Za-z0-9_-]{8,}$/.test(k)) return send(res, 400, { error: "That doesn't look like an API key." });
        saveEnv("MASSIVE_API_KEY", k);
        return send(res, 200, { keySet: true });
      }
      if (p === "/api/folder" && req.method === "POST") return send(res, 200, folderInfo(cleanPath((await body(req)).path)));
      if (p === "/api/open" && req.method === "POST") {
        const t = cleanPath((await body(req)).path);
        if (t && existsSync(t)) openInOs(t);
        return send(res, 200, { ok: true });
      }
      if (p === "/api/strategies/reload" && req.method === "POST") {
        lib = await loadStrategies();
        return send(res, 200, { errors: lib.errors, count: Object.keys(lib.strategies).length });
      }
      if (p === "/api/presets" && req.method === "POST") {
        const b = (await body(req)) as Preset;
        if (!b.name || !b.strategy) return send(res, 400, { error: "A preset needs a name and a strategy." });
        const list = readJson<Preset[]>(PRESETS, []).filter((x) => x.id !== b.id);
        const preset = { ...b, id: b.id || `p${Date.now()}` };
        list.push(preset);
        writeFileSync(PRESETS, JSON.stringify(list, null, 2));
        return send(res, 200, preset);
      }
      if (p.startsWith("/api/presets/") && req.method === "DELETE") {
        const id = decodeURIComponent(p.split("/").pop()!);
        writeFileSync(PRESETS, JSON.stringify(readJson<Preset[]>(PRESETS, []).filter((x) => x.id !== id), null, 2));
        return send(res, 200, { ok: true });
      }

      // Jobs
      if (p === "/api/jobs" && req.method === "POST") {
        const b = await body(req);
        const f = settings.folders;
        const need = (v: string, what: string) => { if (!v) throw new Error(`Set the ${what} folder first (Data tab).`); return v; };
        let job: Job;
        switch (b.kind) {
          case "convert-day": job = queue.add("convert", "Convert daily bars to Parquet", ["convert", "--src", need(f.dayCsv, "daily CSV"), "--dest", need(f.dayParquet, "daily Parquet")]); break;
          case "convert-minute": job = queue.add("convert", "Convert minute bars to Parquet", ["convert", "--src", need(f.minuteCsv, "minute CSV"), "--dest", need(f.minuteParquet, "minute Parquet"), "--group", "day"]); break;
          case "fetch-ref":
            if (!process.env.MASSIVE_API_KEY) throw new Error("Save your Massive API key first (Data tab).");
            job = queue.add("fetch-ref", "Download reference data", ["fetch-ref", "--out", need(f.ref, "reference"), ...(b.details ? ["--details"] : []), "--rps", String(b.rps ?? 20)]);
            break;
          case "prepare": {
            const src = f.dayParquet && existsSync(f.dayParquet) && folderInfo(f.dayParquet).parquetFiles ? f.dayParquet : need(f.dayCsv, "daily CSV or Parquet");
            job = queue.add("prepare", "Prepare backtest data", ["prepare", "--flat", src, "--data", need(f.data, "prepared data"), ...(f.ref ? ["--ref", f.ref] : []),
              ...(settings.prepare.from ? ["--from", settings.prepare.from] : []), "--memory", settings.prepare.memory || "8GB"]);
            break;
          }
          case "demo": {
            const d = join(BT_ROOT, "data", "demo");
            queue.add("synth", "Demo data: generate a synthetic market", ["synth", "--out", d, "--years", "6", "--stocks", "400"]);
            job = queue.add("demo", "Demo data: prepare", ["prepare", "--flat", join(d, "flat"), "--ref", join(d, "ref"), "--data", join(d, "data")]);
            break;
          }
          case "batch": {
            const spec = b.spec as { runs: unknown[] } & Record<string, unknown>;
            if (!spec?.runs?.length) throw new Error("Pick at least one strategy to run.");
            const specs = join(f.results, ".specs");
            mkdirSync(specs, { recursive: true });
            const file = join(specs, `spec-${Date.now()}.json`);
            writeFileSync(file, JSON.stringify(spec, null, 2));
            job = queue.add("batch", String(spec.name || `${spec.runs.length} run${spec.runs.length === 1 ? "" : "s"}`), ["batch", "--data", need(f.data, "prepared data"), "--spec", file, "--out", f.results,
              ...(typeof b.where === "string" && b.where ? ["--where", b.where] : [])]);
            break;
          }
          case "saved-batch": {
            const sb = savedBatches().find((x) => x.file === b.file && !("error" in x));
            if (!sb || "error" in sb) throw new Error("That batch file isn't in the batches folder.");
            job = queue.add("batch", `${sb.name} (${sb.runs.length} runs)`, ["batch", "--data", need(f.data, "prepared data"), "--spec", join(BATCHES, sb.file), "--out", f.results]);
            break;
          }
          case "study-batch": {
            const list = Array.isArray(b.studies) ? (b.studies as { strategy?: unknown; params?: unknown; horizons?: unknown; name?: unknown }[]) : [];
            if (!list.length) throw new Error("Add at least one study to the batch.");
            const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined);
            const studies = list.map((x) => {
              const st = String(x.strategy ?? "");
              if (!lib.strategies[st]) throw new Error(`Unknown strategy "${st}".`);
              const horizons = String(x.horizons ?? "").split(",").map((h) => Math.round(Number(h))).filter((h) => h > 0 && h <= 260);
              return { strategy: st, params: x.params && typeof x.params === "object" ? x.params : {}, horizons: horizons.length ? horizons : undefined, name: typeof x.name === "string" && x.name.trim() ? x.name.trim().slice(0, 60) : undefined };
            });
            const cost = Number(b.cost);
            const spec = { name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : "Study batch", from: date(b.from), to: date(b.to), cost: Number.isFinite(cost) && cost >= 0 ? cost / 100 : 0.002, studies };
            const specs = join(f.results, ".specs");
            mkdirSync(specs, { recursive: true });
            const file = join(specs, `studies-${Date.now()}.json`);
            writeFileSync(file, JSON.stringify(spec, null, 2));
            job = queue.add("study", `Study batch: ${spec.name} (${studies.length})`, ["study", "--data", need(f.data, "prepared data"), "--spec", file, "--out", f.results]);
            break;
          }
          case "study": {
            const st = String(b.strategy ?? "");
            if (!lib.strategies[st]) throw new Error(`Unknown strategy "${st}".`);
            const params = (b.params && typeof b.params === "object" ? b.params : {}) as Record<string, unknown>;
            const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "");
            const horizons = String(b.horizons ?? "5,10,15").split(",").map((x) => Math.round(Number(x))).filter((x) => x > 0 && x <= 260);
            if (!horizons.length) throw new Error("Enter at least one horizon in sessions, e.g. 5,10,15.");
            const from = date(b.from), to = date(b.to), name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
            job = queue.add("study", `Signal study: ${name || st}`, ["study", "--data", need(f.data, "prepared data"), "--strategy", st, "--out", f.results,
              "--horizons", horizons.join(","), ...(from ? ["--from", from] : []), ...(to ? ["--to", to] : []), ...(name ? ["--name", name] : []),
              ...(Number.isFinite(Number(b.cost)) && b.cost !== "" && b.cost != null ? ["--cost", String(Number(b.cost))] : []),
              ...Object.entries(params).flatMap(([k, v]) => ["--set", `${k}=${v}`])]);
            break;
          }
          default: return send(res, 400, { error: "Unknown job" });
        }
        return send(res, 200, job);
      }
      if (p.match(/^\/api\/jobs\/\d+\/cancel$/) && req.method === "POST") return send(res, 200, { ok: queue.cancel(Number(p.split("/")[3])) });
      if (p === "/api/events" && req.method === "GET") {
        // Server-sent events: every job change and log line.
        res.on("error", () => {}); // a closed browser tab must not take the app down
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        const write = (s: string) => { if (!res.destroyed && !res.writableEnded) res.write(s); };
        const off = queue.subscribe(({ job, line }) => write(`data: ${JSON.stringify({ job: { ...job, log: undefined }, line: line ?? null })}\n\n`));
        const ping = setInterval(() => write(": ping\n\n"), 15000);
        req.on("close", () => { off(); clearInterval(ping); });
        return;
      }

      // Results
      const root = settings.folders.results;
      if (p === "/api/results" && req.method === "GET") return send(res, 200, listResults(root));
      const dirParam = (name = "dir") => {
        const d = join(root, String(url.searchParams.get(name) ?? ""));
        if (!inside(root, d) || !existsSync(d)) throw new Error("Not found");
        return d;
      };
      if (p === "/api/results/batch" && req.method === "GET") {
        const d = dirParam();
        const b = readJson<Record<string, unknown>>(join(d, "batch.json"), {});
        const bench = Object.fromEntries(readdirSync(d).filter((x) => x.startsWith("bench-")).map((x) => [x.slice(6), thin(readCsv(join(d, x, "equity.csv")) as { d: string; equity: number }[], 800).map((r) => [r.d, r.equity])]));
        const curves = Object.fromEntries(((b.runs ?? []) as { folder: string }[]).map((r) => [r.folder, thin(readCsv(join(d, r.folder, "equity.csv")) as { d: string; equity: number }[], 800).map((x) => [x.d, x.equity])]));
        return send(res, 200, { ...b, dir: url.searchParams.get("dir"), path: d, bench, curves });
      }
      if (p === "/api/results/run" && req.method === "GET") {
        const d = dirParam();
        const run = join(d, String(url.searchParams.get("run") ?? ""));
        if (!inside(d, run) || !existsSync(run)) throw new Error("Not found");
        const summary = readJson<Record<string, unknown>>(join(run, "summary.json"), {});
        const equity = thin(readCsv(join(run, "equity.csv")) as { d: string; equity: number; invested: number; positions: number }[]);
        const bench = Object.fromEntries(readdirSync(d).filter((x) => x.startsWith("bench-")).map((x) => [x.slice(6), thin(readCsv(join(d, x, "equity.csv")) as { d: string; equity: number }[]).map((r) => [r.d, r.equity])]));
        return send(res, 200, { summary, path: run, equity: equity.map((r) => [r.d, r.equity, r.invested, r.positions]), bench, trades: readCsv(join(run, "trades.csv"), 20000) });
      }
      // Signal studies: <results>/studies/<stamp>-<name>/study.json
      const studies = join(root, "studies");
      if (p === "/api/studies" && req.method === "GET") {
        if (!existsSync(studies)) return send(res, 200, []);
        const list = readdirSync(studies).map((name) => ({ name, s: readJson<Record<string, unknown> | null>(join(studies, name, "study.json"), null) }))
          .filter((x) => x.s).map(({ name, s }) => ({ dir: name, name: s!.name, created: s!.created, strategy: s!.strategy, params: s!.params, from: s!.from, to: s!.to,
            horizons: s!.horizons, cost: s!.cost ?? null, batch: s!.batch ?? null, all: (s!.rows as unknown[]).at(-1) }));
        return send(res, 200, list.sort((a, b) => String(b.created).localeCompare(String(a.created))));
      }
      const studyDir = () => {
        const d = join(studies, String(url.searchParams.get("dir") ?? ""));
        if (!inside(studies, d) || !existsSync(join(d, "study.json"))) throw new Error("Not found");
        return d;
      };
      if (p === "/api/studies/one" && req.method === "GET") {
        const d = studyDir();
        return send(res, 200, { ...readJson<Record<string, unknown>>(join(d, "study.json"), {}), dir: url.searchParams.get("dir"), path: d });
      }
      if (p === "/api/studies" && req.method === "DELETE") {
        rmSync(studyDir(), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      if (p === "/api/results" && req.method === "DELETE") {
        const d = dirParam();
        rmSync(d, { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      logError(`${req.method} ${req.url}`, e);
      if (res.headersSent) { res.end(); return; }
      return send(res, 400, { error: String(e instanceof Error ? e.message : e) });
    }
  });

  const port = o.port ?? 5178;
  const host = o.host ?? "127.0.0.1";
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, host, ok); });
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://localhost:${actual}`;
  console.log(`Backtest app running at ${url}  (close this window to stop it)`);
  if (o.open) openInOs(url);
  return { server, url, port: actual, queue };
}

export const _test = { thin, readCsv, inside, dirname };
