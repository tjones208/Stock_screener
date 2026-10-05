// Prepare from Parquet made by other tools: different column names, extra files in the folder,
// and prices that may already be split-adjusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synth } from "../src/data/synth.ts";
import { prepare } from "../src/data/prepare.ts";
import { Duck, lit } from "../src/data/duck.ts";

test("prepare: foreign Parquet columns (date, symbol), extra reference file, adjusted or not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bt-foreign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = synth({ out: dir, years: 2, stocks: 20, seed: 9, splits: 6 });
  const db = await Duck.open();
  t.after(() => db.close());
  const csv = `read_csv(${lit(join(dir, "flat", "**", "*.csv.gz"))}, header = true, filename = true)`;
  const day = `regexp_extract(filename, '(\\d{4}-\\d{2}-\\d{2})', 1)::date`;
  // Raw (unadjusted) prices with other column names, plus a reference file in the same folder.
  for (const sub of ["raw", "adj"]) mkdirSync(join(dir, sub), { recursive: true });
  await db.run(`copy (select ticker as symbol, ${day} as date, open, high, low, close, volume from ${csv}) to ${lit(join(dir, "raw", "bars.parquet"))} (format parquet)`);
  await db.run(`copy (select 'S001' as ticker, date '2020-06-01' as delist_date, true as is_delisted) to ${lit(join(dir, "raw", "delisted.parquet"))} (format parquet)`);
  // Already split-adjusted prices (as many tools deliver them), date as epoch milliseconds.
  await db.run(`create table sp as select ticker, execution_date::date ed, split_from / split_to f from read_json(${lit(join(dir, "ref", "splits.jsonl"))}, format = 'newline_delimited')`);
  await db.run(`copy (select b.ticker as symbol, epoch_ms(${day}::timestamp) as date,
      b.open * coalesce(sp.f, 1) as open, b.high * coalesce(sp.f, 1) as high, b.low * coalesce(sp.f, 1) as low, b.close * coalesce(sp.f, 1) as close, b.volume
    from ${csv} b left join sp on sp.ticker = b.ticker and ${day} < sp.ed) to ${lit(join(dir, "adj", "bars.parquet"))} (format parquet)`);

  const logs: Record<string, string[]> = { raw: [], adj: [] };
  for (const k of ["raw", "adj"] as const) {
    await prepare({ flat: join(dir, k), ref: join(dir, "ref"), out: join(dir, `out-${k}`), log: (x) => logs[k].push(x) });
  }
  assert.match(logs.raw.join("\n"), /ticker=(ticker\/)?symbol, date=date/);
  assert.match(logs.raw.join("\n"), /prices are unadjusted/);
  assert.match(logs.adj.join("\n"), /ALREADY split-adjusted/);
  // Both routes give the same adjusted closes for a split ticker.
  const q = (k: string) => db.all<{ d: string; c: number }>(`select d, c from read_parquet(${lit(join(dir, `out-${k}`, "daily", "*", "*.parquet"))}) where ticker = ${lit(s.split.ticker)} order by d`);
  const [a, b] = [await q("raw"), await q("adj")];
  assert.equal(a.length, b.length);
  assert.ok(a.length > 400);
  for (let i = 0; i < a.length; i += 50) assert.ok(Math.abs(a[i].c - b[i].c) < 1e-6 * a[i].c, `${a[i].d}: ${a[i].c} vs ${b[i].c}`);

  // A folder without price columns explains what it found.
  mkdirSync(join(dir, "bad"));
  await db.run(`copy (select 'X' as ticker, date '2020-01-01' as date, 1.0 as price) to ${lit(join(dir, "bad", "x.parquet"))} (format parquet)`);
  await assert.rejects(prepare({ flat: join(dir, "bad"), out: join(dir, "out-bad"), log: () => {} }), /no column for: open, high, low, close\. Columns found: ticker \(VARCHAR\), date \(DATE\), price/);
});
