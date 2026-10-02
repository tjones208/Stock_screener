// Download daily history from Yahoo Finance into local CSV files.
//
//   npm run yahoo:fetch                         # S&P 500 + benchmark ETFs since 2010
//   npm run yahoo:fetch -- --tickers SPY,AAPL --start 2015-01-01
//   npm run yahoo:fetch -- --out data/yahoo --concurrency 2
//
// One file per ticker: <out>/<TICKER>.csv  (date,open,high,low,close,adj_close,volume)
// plus <out>/_splits.csv and <out>/_dividends.csv. OHLC is as traded (split-adjusted
// by Yahoo), adj_close also folds in dividends. Re-running only fetches the days after
// the last stored date, so it's cheap to run nightly.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const BENCHMARKS = ["SPY", "MTUM", "SPMO", "SGOV", "QQQ", "IWM"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const HEADER = "date,open,high,low,close,adj_close,volume";

type Bar = { date: string; open: number; high: number; low: number; close: number; adj: number; volume: number };
type Event = { ticker: string; date: string; value: string };

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    tickers: get("tickers")?.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean),
    start: get("start") ?? "2010-01-01",
    out: get("out") ?? "data/yahoo",
    concurrency: Number(get("concurrency") ?? 3),
    full: a.includes("--full"),
  };
}

async function sp500(): Promise<string[]> {
  const res = await fetch(SP500_CSV);
  if (!res.ok) throw new Error(`S&P 500 list: HTTP ${res.status}`);
  return (await res.text()).trim().split("\n").slice(1).map((l) => l.split(",")[0].replace(/"/g, "").trim()).filter(Boolean);
}

// Yahoo uses '-' for share classes (BRK.B → BRK-B).
const yahooSymbol = (t: string) => t.replace(/\./g, "-");

const ymd = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : NaN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchChart(ticker: string, from: string) {
  const p1 = Math.floor(Date.parse(from) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(ticker))}` +
    `?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw new Error(`HTTP ${res.status}`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const body = (await res.json().catch(() => null)) as any;
    const err = body?.chart?.error;
    if (!res.ok || err) throw new Error(err?.description ?? `HTTP ${res.status}`);
    return body.chart.result?.[0];
  }
}

function parse(ticker: string, r: any) {
  const ts: number[] = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: Bar[] = [];
  ts.forEach((t, i) => {
    const close = q.close?.[i];
    if (close == null) return; // holidays / halted days come back as nulls
    bars.push({
      date: ymd(t),
      open: round(q.open?.[i]),
      high: round(q.high?.[i]),
      low: round(q.low?.[i]),
      close: round(close),
      adj: round(adj[i] ?? close),
      volume: q.volume?.[i] ?? 0,
    });
  });
  const splits: Event[] = Object.values(r?.events?.splits ?? {}).map((s: any) => ({
    ticker,
    date: ymd(s.date),
    value: `${s.numerator}:${s.denominator}`,
  }));
  const dividends: Event[] = Object.values(r?.events?.dividends ?? {}).map((d: any) => ({
    ticker,
    date: ymd(d.date),
    value: String(d.amount),
  }));
  return { bars, splits, dividends };
}

async function readBars(file: string): Promise<Bar[]> {
  if (!existsSync(file)) return [];
  const lines = (await readFile(file, "utf8")).trim().split("\n").slice(1);
  return lines.filter(Boolean).map((l) => {
    const [date, open, high, low, close, adj, volume] = l.split(",");
    return { date, open: +open, high: +high, low: +low, close: +close, adj: +adj, volume: +volume };
  });
}

const toCsv = (bars: Bar[]) =>
  [HEADER, ...bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.adj, b.volume].join(","))].join("\n") + "\n";

async function main() {
  const opt = args();
  await mkdir(opt.out, { recursive: true });
  const tickers = [...new Set(opt.tickers ?? [...BENCHMARKS, ...(await sp500())])];
  console.log(`Fetching ${tickers.length} tickers → ${opt.out} (from ${opt.start})`);

  const splits: Event[] = [];
  const dividends: Event[] = [];
  const failed: string[] = [];
  let done = 0;

  async function one(ticker: string) {
    const file = path.join(opt.out, `${ticker}.csv`);
    const old = opt.full ? [] : await readBars(file);
    // Re-fetch the last stored week so revised bars overwrite, and refetch everything after
    // a split or dividend since Yahoo restates adj_close (and OHLC for splits) backwards.
    const from = old.length ? old[Math.max(0, old.length - 5)].date : opt.start;
    try {
      const r = await fetchChart(ticker, from);
      let { bars, splits: s, dividends: d } = parse(ticker, r);
      const restated = old.length && (s.some((e) => e.date > old[old.length - 1].date) || d.some((e) => e.date > old[old.length - 1].date));
      if (restated) ({ bars, splits: s, dividends: d } = parse(ticker, await fetchChart(ticker, opt.start)));
      const merged = new Map((restated ? [] : old).map((b) => [b.date, b]));
      for (const b of bars) merged.set(b.date, b);
      const all = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
      await writeFile(file, toCsv(all));
      splits.push(...s);
      dividends.push(...d);
    } catch (e) {
      failed.push(`${ticker}: ${(e as Error).message}`);
    }
    if (++done % 25 === 0 || done === tickers.length) console.log(`  ${done}/${tickers.length}`);
  }

  const queue = [...tickers];
  await Promise.all(
    Array.from({ length: Math.max(1, opt.concurrency) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        await one(t);
        await sleep(250);
      }
    }),
  );

  await mergeEvents(path.join(opt.out, "_splits.csv"), "ticker,date,ratio", splits);
  await mergeEvents(path.join(opt.out, "_dividends.csv"), "ticker,date,amount", dividends);

  console.log(`Done: ${tickers.length - failed.length} saved, ${failed.length} failed.`);
  if (failed.length) {
    console.log(failed.map((f) => `  ${f}`).join("\n"));
    process.exitCode = 1;
  }
}

async function mergeEvents(file: string, header: string, events: Event[]) {
  const rows = new Map<string, string>();
  if (existsSync(file)) for (const l of (await readFile(file, "utf8")).trim().split("\n").slice(1)) if (l) rows.set(l.split(",").slice(0, 2).join(","), l);
  for (const e of events) rows.set(`${e.ticker},${e.date}`, `${e.ticker},${e.date},${e.value}`);
  await writeFile(file, [header, ...[...rows.values()].sort()].join("\n") + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
