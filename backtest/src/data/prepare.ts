// One-time conversion of Massive flat files (+ reference data) into the backtest data set:
//   <out>/daily/year=YYYY/data.parquet   split-adjusted OHLCV + features, sorted by date
//   <out>/tickers.parquet                ticker, name, type, exchange, active, delisted, sic_code
//   <out>/dividends.parquet              ticker, ex_date, cash (per split-adjusted share)
//   <out>/calendar.parquet               trading days
// Massive day aggregates are unadjusted; prices are adjusted to today's share basis with the
// splits list, so returns across a split are continuous and share counts stay comparable.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Duck, lit } from "./duck.ts";
import { isParquetDir } from "./convert.ts";

export type PrepareOptions = {
  /** Massive day aggregates: the downloaded …/day_aggs_v1 folder (*.csv.gz) or its `bt convert` Parquet copy. */
  flat: string;
  /** Folder with reference files from `bt fetch-ref` (tickers.jsonl, splits.jsonl, dividends.jsonl, details.jsonl). */
  ref?: string;
  out: string;
  from?: string;
  to?: string;
  memoryLimit?: string;
  log?: (s: string) => void;
  onProgress?: (done: number, total: number, label: string) => void;
};

const FEATURES = String.raw`
  with b as (
    select *, row_number() over w as n, lag(c) over w as pc
    from src window w as (partition by ticker order by d)
  ),
  x as (
    select *,
      case when pc > 0 and c > 0 then ln(c / pc) end as lr,
      case when pc > 0 then greatest(h - l, abs(h - pc), abs(l - pc)) end as tr
    from b
  )
  select ticker, d, o, h, l, c, v, dv, n::integer as n, first_d,
    case when pc > 0 then c / pc - 1 end as ret1,
    case when n > 21 then c / nullif(lag(c, 21) over w, 0) - 1 end as ret21,
    case when n > 63 then c / nullif(lag(c, 63) over w, 0) - 1 end as ret63,
    case when n > 126 then c / nullif(lag(c, 126) over w, 0) - 1 end as ret126,
    case when n > 252 then c / nullif(lag(c, 252) over w, 0) - 1 end as ret252,
    case when n > 252 then lag(c, 21) over w / nullif(lag(c, 252) over w, 0) - 1 end as mom_12_1,
    case when n >= 20 then avg(c) over (w rows 19 preceding) end as sma20,
    case when n >= 50 then avg(c) over (w rows 49 preceding) end as sma50,
    case when n >= 200 then avg(c) over (w rows 199 preceding) end as sma200,
    max(c) over (w rows 251 preceding) as hi252,
    min(c) over (w rows 251 preceding) as lo252,
    (n - arg_max(n, [c, n]) over (w rows 251 preceding))::integer as days_since_high,
    case when n > 20 then stddev_samp(lr) over (w rows 19 preceding) * sqrt(252) end as vol20,
    case when n > 63 then stddev_samp(lr) over (w rows 62 preceding) * sqrt(252) end as vol63,
    case when n > 200 then stddev_samp(lr) over (w rows 251 preceding) * sqrt(252) end as vol252,
    case when n > 14 then avg(tr) over (w rows 13 preceding) end as atr14,
    case when n > 20 then avg(tr) over (w rows 19 preceding) end as atr20,
    avg(dv) over (w rows 19 preceding) as avg_dv20,
    median(dv) over (w rows 59 preceding) as median_dv60
  from x
  window w as (partition by ticker order by d)`;

export async function prepare(o: PrepareOptions) {
  const log = o.log ?? console.log;
  mkdirSync(o.out, { recursive: true });
  const tmp = join(o.out, "tmp");
  mkdirSync(tmp, { recursive: true });
  const db = await Duck.open(":memory:", { memory_limit: o.memoryLimit ?? "4GB", temp_directory: tmp, preserve_insertion_order: "false" });
  const ref = (f: string) => (o.ref && existsSync(join(o.ref, f)) ? join(o.ref, f) : null);

  log("Reading day aggregates…");
  const where = [o.from ? `d >= ${lit(o.from)}::date - interval 420 day` : null, o.to ? `d <= ${lit(o.to)}::date` : null].filter(Boolean).join(" and ");
  // Converted Parquet (bt convert) or the raw *.csv.gz files.
  const source = isParquetDir(o.flat)
    ? `select ticker, d, open, high, low, close, volume from read_parquet(${lit(join(o.flat, "**", "*.parquet"))}, union_by_name = true)`
    : `select *, regexp_extract(filename, '(\\d{4}-\\d{2}-\\d{2})', 1)::date d
      from read_csv(${lit(join(o.flat, "**", "*.csv.gz"))}, header = true, filename = true, union_by_name = true,
        types = {'ticker': 'VARCHAR', 'volume': 'DOUBLE', 'open': 'DOUBLE', 'close': 'DOUBLE', 'high': 'DOUBLE', 'low': 'DOUBLE'})`;
  await db.run(`create table raw as
    select ticker, d, open::double o, high::double h, low::double l, close::double c, volume::double v from (${source})
    where close > 0 ${where ? `and ${where}` : ""}`);
  const [{ n, d0, d1 }] = await db.all<{ n: number; d0: string; d1: string }>(`select count(*)::double n, min(d)::varchar d0, max(d)::varchar d1 from raw`);
  log(`  ${n.toLocaleString()} bars, ${d0} → ${d1}`);

  // Splits → cumulative factor for every date before each split.
  const splits = ref("splits.jsonl");
  if (splits) {
    await db.run(`create table split_cum as
      with s as (
        select ticker, execution_date::date ed, max(split_from::double) sf, max(split_to::double) st
        from read_json(${lit(splits)}, format = 'newline_delimited') where split_from > 0 and split_to > 0 group by 1, 2
      )
      select ticker, ed, exp(sum(ln(sf / st)) over (partition by ticker order by ed desc rows between unbounded preceding and current row)) f from s`);
  } else {
    log("  No splits.jsonl: prices are NOT split-adjusted (run `bt fetch-ref` first).");
    await db.run(`create table split_cum (ticker varchar, ed date, f double)`);
  }
  await db.run(`create table adj as
    select r.ticker, r.d, r.o * coalesce(s.f, 1) o, r.h * coalesce(s.f, 1) h, r.l * coalesce(s.f, 1) l, r.c * coalesce(s.f, 1) c,
           r.v / coalesce(s.f, 1) v, r.c * r.v dv, min(r.d) over (partition by r.ticker) first_d
    from raw r asof left join split_cum s on r.ticker = s.ticker and r.d < s.ed`);
  await db.run(`drop table raw`);

  // Calendar: days where the market broadly traded (filters stray weekend / holiday files).
  await db.run(`create table cal as
    with k as (select d, count(*) n from adj group by d)
    select d from k where n >= 0.5 * (select median(n) from k) order by d`);
  await db.run(`copy (select d::varchar d from cal ${o.from ? `where d >= ${lit(o.from)}::date - interval 420 day` : ""} order by d) to ${lit(join(o.out, "calendar.parquet"))} (format parquet)`);

  // Features, one calendar year at a time with ~420 days of look-back so every window is complete.
  const daily = join(o.out, "daily");
  if (existsSync(daily)) rmSync(daily, { recursive: true });
  const years = (await db.all<{ y: number }>(`select distinct year(d)::integer y from cal ${o.from ? `where d >= ${lit(o.from)}::date` : ""} order by y`)).map((r) => r.y);
  for (const [yi, y] of years.entries()) {
    o.onProgress?.(yi, years.length, `Features ${y}`);
    await db.run(`create or replace table src as select * from adj where d between make_date(${y}, 1, 1) - interval 420 day and make_date(${y}, 12, 31)`);
    const dir = join(daily, `year=${y}`);
    mkdirSync(dir, { recursive: true });
    await db.run(`copy (
        select f.* replace (f.d::varchar as d, f.first_d::varchar as first_d)
        from (${FEATURES}) f where year(f.d) = ${y} and f.d in (select d from cal)
        order by f.d, f.ticker
      ) to ${lit(join(dir, "data.parquet"))} (format parquet, row_group_size 100000)`);
    const [{ k }] = await db.all<{ k: number }>(`select count(*)::double k from read_parquet(${lit(join(dir, "data.parquet"))})`);
    log(`  ${y}: ${k.toLocaleString()} rows`);
  }

  // Ticker reference (active + delisted), SIC codes from details when downloaded.
  const tickers = ref("tickers.jsonl"), details = ref("details.jsonl");
  await db.run(`create table tk as
    select distinct on (ticker) ticker, name, type, primary_exchange as exchange, coalesce(active, false) active,
      try_cast(delisted_utc as timestamp)::date::varchar delisted
    from ${tickers ? `read_json(${lit(tickers)}, format = 'newline_delimited', union_by_name = true)` : `(select null::varchar ticker, null::varchar name, null::varchar type, null::varchar primary_exchange, null::boolean active, null::varchar delisted_utc where false)`}
    order by ticker, active desc, delisted_utc desc nulls first`);
  await db.run(`copy (
      select coalesce(t.ticker, a.ticker) ticker, t.name, t.type, t.exchange, coalesce(t.active, false) active, t.delisted,
        ${details ? `dt.sic_code` : `null::varchar`} sic_code
      from (select distinct ticker from adj) a full join tk t on t.ticker = a.ticker
      ${details ? `left join (select distinct on (ticker) ticker, sic_code::varchar sic_code from read_json(${lit(details)}, format = 'newline_delimited', union_by_name = true)) dt on dt.ticker = coalesce(t.ticker, a.ticker)` : ""}
    ) to ${lit(join(o.out, "tickers.parquet"))} (format parquet)`);

  // Dividends as cash per split-adjusted share.
  const divs = ref("dividends.jsonl");
  await db.run(`copy (
      ${divs ? `select dv.ticker, dv.ex_dividend_date::varchar ex_date, dv.cash_amount::double * coalesce(s.f, 1) cash
      from (select distinct on (ticker, ex_dividend_date) ticker, ex_dividend_date::date ex_dividend_date, cash_amount
            from read_json(${lit(divs)}, format = 'newline_delimited', union_by_name = true) where cash_amount > 0) dv
      asof left join split_cum s on dv.ticker = s.ticker and dv.ex_dividend_date < s.ed`
      : `select null::varchar ticker, null::varchar ex_date, null::double cash where false`}
    ) to ${lit(join(o.out, "dividends.parquet"))} (format parquet)`);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  log(`Done: ${o.out}`);
  return { bars: n, from: d0, to: d1, years };
}

export const dataReady = (dir: string) =>
  existsSync(join(dir, "calendar.parquet")) && existsSync(join(dir, "daily")) && readdirSync(join(dir, "daily")).length > 0;
