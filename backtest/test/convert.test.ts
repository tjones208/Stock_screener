// Flat files → Parquet: lossless, incremental, and prepare gives the same result from either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { synth } from "../src/data/synth.ts";
import { convert, listFlatFiles } from "../src/data/convert.ts";
import { prepare } from "../src/data/prepare.ts";
import { Duck, lit } from "../src/data/duck.ts";

test("convert: day aggregates → monthly Parquet, lossless and incremental; prepare reads it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bt-conv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  synth({ out: dir, years: 2, stocks: 10, seed: 3 });
  const pq = join(dir, "pq");
  const r1 = await convert({ src: join(dir, "flat"), dest: pq, log: () => {} });
  assert.equal(r1.group, "month");
  assert.equal(r1.isAgg, true);
  const db = await Duck.open();
  t.after(() => db.close());
  const [csv] = await db.all<{ n: number; v: number }>(`select count(*)::double n, sum(close * volume)::double v from read_csv(${lit(join(dir, "flat", "**", "*.csv.gz"))}, header = true)`);
  const [par] = await db.all<{ n: number; v: number; d0: string; ts0: string }>(`select count(*)::double n, sum(close * volume)::double v, min(d)::varchar d0, min(ts)::varchar ts0 from read_parquet(${lit(join(pq, "**", "*.parquet"))})`);
  assert.equal(par.n, csv.n);
  assert.ok(Math.abs(par.v - csv.v) < 1e-3 * csv.v);
  assert.equal(par.d0, listFlatFiles(join(dir, "flat"))[0].d);
  assert.ok(par.ts0.startsWith(par.d0));
  // Second run: nothing to do. Touch one day's file: only its month is rebuilt.
  assert.equal((await convert({ src: join(dir, "flat"), dest: pq, log: () => {} })).written, 0);
  const f = listFlatFiles(join(dir, "flat"))[40];
  utimesSync(f.path, new Date(), new Date(Date.now() + 60_000));
  assert.equal((await convert({ src: join(dir, "flat"), dest: pq, log: () => {} })).written, 1);
  // prepare from Parquet = prepare from CSV.
  await prepare({ flat: join(dir, "flat"), ref: join(dir, "ref"), out: join(dir, "a"), log: () => {} });
  await prepare({ flat: pq, ref: join(dir, "ref"), out: join(dir, "b"), log: () => {} });
  const q = (x: string) => db.all<{ n: number; s: number }>(`select count(*)::double n, sum(c + coalesce(mom_12_1, 0))::double s from read_parquet(${lit(join(dir, x, "daily", "*", "*.parquet"))})`);
  const [a] = await q("a"), [b] = await q("b");
  assert.equal(a.n, b.n);
  assert.ok(Math.abs(a.s - b.s) < 1e-6 * Math.abs(a.s));
});

test("convert: large per-day files (e.g. minute aggregates) → one Parquet per day; other datasets keep their columns", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bt-min-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const minute = join(dir, "minute_aggs_v1", "2024", "01");
  mkdirSync(minute, { recursive: true });
  for (const d of ["2024-01-02", "2024-01-03"]) {
    const t0 = Date.parse(`${d}T14:30:00Z`) * 1e6;
    const rows = Array.from({ length: 390 }, (_, k) => `AAA,${100 + k},10,10.1,10.2,9.9,${t0 + k * 60e9},5`);
    writeFileSync(join(minute, `${d}.csv.gz`), gzipSync("ticker,volume,open,close,high,low,window_start,transactions\n" + rows.join("\n") + "\n"));
  }
  const r = await convert({ src: join(dir, "minute_aggs_v1"), dest: join(dir, "pq"), group: "day", log: () => {} });
  assert.deepEqual([r.written, r.rows], [2, 780]);
  const db = await Duck.open();
  t.after(() => db.close());
  const [x] = await db.all<{ ts: string; n: number }>(`select min(ts)::varchar ts, count(*)::double n from read_parquet(${lit(join(dir, "pq", "year=2024", "month=01", "2024-01-03.parquet"))})`);
  assert.deepEqual([x.ts, x.n], ["2024-01-03 14:30:00", 390]);
  // A non-aggregate dataset (e.g. trades) keeps its own columns, plus d.
  const trades = join(dir, "trades_v1", "2024", "01");
  mkdirSync(trades, { recursive: true });
  writeFileSync(join(trades, "2024-01-02.csv.gz"), gzipSync("ticker,price,size,sip_timestamp\nAAA,10.01,100,1704205800000000000\nAAA,10.02,50,1704205801000000000\n"));
  await convert({ src: join(dir, "trades_v1"), dest: join(dir, "tq"), log: () => {} });
  const cols = (await db.all<{ column_name: string }>(`select column_name from (describe select * from read_parquet(${lit(join(dir, "tq", "**", "*.parquet"))}, hive_partitioning = false))`)).map((c) => c.column_name);
  assert.deepEqual(cols, ["ticker", "price", "size", "sip_timestamp", "d"]);
});
