// Convert downloaded Massive flat files (*.csv.gz, one file per trading day) into compressed
// Parquet, keeping every column as delivered (prices stay unadjusted) and adding:
//   d   DATE       the trading day, from the file name
//   ts  TIMESTAMP  bar start in UTC, for aggregate files (from window_start, nanoseconds)
// Layout: <dest>/year=YYYY/month=MM/data.parquet for small daily files (day aggregates), or
// <dest>/year=YYYY/month=MM/YYYY-MM-DD.parquet for large ones (minute aggregates, trades, quotes).
// Incremental: an output is rebuilt only when it's missing or older than one of its source files.
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { Duck, lit } from "./duck.ts";

export type ConvertOptions = {
  src: string;
  dest: string;
  /** "month" groups days into one file, "day" keeps one file per day, "auto" decides by file size. */
  group?: "auto" | "month" | "day";
  force?: boolean;
  memoryLimit?: string;
  log?: (s: string) => void;
};

const AGG_COLUMNS = ["ticker", "volume", "open", "close", "high", "low", "window_start", "transactions"];
const AGG_TYPES = `{'ticker': 'VARCHAR', 'volume': 'DOUBLE', 'open': 'DOUBLE', 'close': 'DOUBLE', 'high': 'DOUBLE', 'low': 'DOUBLE', 'window_start': 'BIGINT', 'transactions': 'BIGINT'}`;

/** Every *.csv.gz / *.csv under a folder with a YYYY-MM-DD in its name. */
export function listFlatFiles(src: string) {
  const out: { path: string; d: string; size: number; mtime: number }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.csv(\.gz)?$/.test(e.name)) {
        const m = e.name.match(/(\d{4}-\d{2}-\d{2})/);
        if (!m) continue;
        const st = statSync(p);
        out.push({ path: p, d: m[1], size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(src);
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

/** Header line of a (gzipped) CSV file. */
async function header(path: string): Promise<string[]> {
  const stream = path.endsWith(".gz") ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString();
    const nl = buf.indexOf("\n");
    if (nl >= 0) { stream.destroy(); return buf.slice(0, nl).trim().split(",").map((s) => s.replace(/"/g, "")); }
  }
  return buf.trim().split(",");
}

export async function convert(o: ConvertOptions) {
  const log = o.log ?? console.log;
  const files = listFlatFiles(o.src);
  if (!files.length) throw new Error(`No *.csv.gz files with a date in the name under ${o.src}`);
  const cols = await header(files[0].path);
  const isAgg = AGG_COLUMNS.every((c) => cols.includes(c));
  const median = [...files].sort((a, b) => a.size - b.size)[Math.floor(files.length / 2)].size;
  const group = o.group && o.group !== "auto" ? o.group : median > 5e6 ? "day" : "month";
  const groups = new Map<string, typeof files>();
  for (const f of files) {
    const k = group === "day" ? f.d : f.d.slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  log(`${files.length} files (${isAgg ? "aggregates" : `columns: ${cols.join(", ")}`}), ${groups.size} ${group} file(s) → ${o.dest}`);
  const tmp = join(o.dest, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const db = await Duck.open(":memory:", { memory_limit: o.memoryLimit ?? "4GB", temp_directory: tmp, preserve_insertion_order: "false" });
  let written = 0, skipped = 0, rows = 0;
  for (const [k, fs] of groups) {
    const dir = join(o.dest, `year=${k.slice(0, 4)}`, `month=${k.slice(5, 7)}`);
    const out = join(dir, group === "day" ? `${k}.parquet` : "data.parquet");
    const newest = Math.max(...fs.map((f) => f.mtime));
    if (!o.force && existsSync(out) && statSync(out).mtimeMs >= newest) { skipped++; continue; }
    mkdirSync(dir, { recursive: true });
    const part = join(tmp, `${k}.parquet`);
    const select = isAgg
      ? `select * exclude (filename), regexp_extract(filename, '(\\d{4}-\\d{2}-\\d{2})', 1)::date d, make_timestamp(window_start // 1000) ts
         from read_csv([${fs.map((f) => lit(f.path)).join(", ")}], header = true, filename = true, union_by_name = true, types = ${AGG_TYPES})
         order by ticker, window_start`
      : `select * exclude (filename), regexp_extract(filename, '(\\d{4}-\\d{2}-\\d{2})', 1)::date d
         from read_csv([${fs.map((f) => lit(f.path)).join(", ")}], header = true, filename = true, union_by_name = true)`;
    await db.run(`copy (${select}) to ${lit(part)} (format parquet, compression zstd, row_group_size 122880)`);
    const [{ n }] = await db.all<{ n: number }>(`select count(*)::double n from read_parquet(${lit(part)})`);
    renameSync(part, out);
    written++;
    rows += n;
    log(`  ${k}: ${n.toLocaleString()} rows`);
  }
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  log(`Done: ${written} written (${rows.toLocaleString()} rows), ${skipped} already up to date.`);
  return { written, skipped, rows, group, isAgg };
}

/** True when a folder holds converted Parquet (as opposed to raw *.csv.gz). */
export function isParquetDir(dir: string): boolean {
  const walk = (d: string): boolean => readdirSync(d, { withFileTypes: true }).some((e) =>
    e.isDirectory() ? !e.name.startsWith(".") && walk(join(d, e.name)) : e.name.endsWith(".parquet"));
  return existsSync(dir) && walk(dir);
}
