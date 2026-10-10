import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { earningsFilings, fetchEarnings } from "../src/data/fetch-earnings.ts";
import { runEarningsStudy } from "../src/earnings-study.ts";
import { Duck, lit } from "../src/data/duck.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

test("earningsFilings: 8-Ks whose items include 2.02 (not amendments, not other items)", () => {
  assert.deepEqual(earningsFilings({ form: ["8-K", "8-K", "10-Q", "8-K/A", "8-K"], filingDate: ["2012-01-20", "2012-02-01", "2012-03-01", "2012-01-25", "2012-04-01"],
    items: ["2.02,9.01", "7.01", "", "2.02", "1.01,2.02"] }), ["2012-01-20", "2012-04-01"]);
  assert.deepEqual(earningsFilings(undefined), []);
});

test("fetchEarnings: CIKs from Massive then SEC, older files, ticker reuse, User-Agent, rate limit, resume, coverage", async () => {
  const ref = mkdtempSync(join(tmpdir(), "bt-sec-ref-")), data = mkdtempSync(join(tmpdir(), "bt-sec-data-"));
  writeFileSync(join(ref, "tickers.jsonl"), [
    { ticker: "AAA", type: "CS", cik: "0000000001", active: true, delisted_utc: null },
    { ticker: "BBB", type: "CS", cik: "0000000002", active: false, delisted_utc: "2010-06-30T00:00:00Z" },
    { ticker: "BBB", type: "CS", cik: "0000000003", active: true, delisted_utc: null },
    { ticker: "CCC", type: "CS", active: true, delisted_utc: null },
    { ticker: "DDD", type: "CS", active: false, delisted_utc: "2009-01-01T00:00:00Z" },
    { ticker: "SPY", type: "ETF", active: true, delisted_utc: null },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const sub = (forms: string[], dates: string[], items: string[], files: object[] = []) => ({ filings: { recent: { form: forms, filingDate: dates, items }, files } });
  const pages: Record<string, unknown> = {
    "https://sec.test/files/company_tickers.json": { 0: { cik_str: 4, ticker: "CCC", title: "C" }, 1: { cik_str: 1, ticker: "AAA", title: "A" } },
    "https://data.test/submissions/CIK0000000001.json": sub(["8-K", "8-K", "10-Q"], ["2012-01-20", "2012-02-01", "2012-03-01"], ["2.02,9.01", "7.01", ""],
      [{ name: "CIK0000000001-submissions-001.json", filingTo: "2008-12-31" }, { name: "CIK0000000001-submissions-002.json", filingTo: "2001-12-31" }]),
    "https://data.test/submissions/CIK0000000001-submissions-001.json": { form: ["8-K"], filingDate: ["2008-04-20"], items: ["2.02"] },
    "https://data.test/submissions/CIK0000000002.json": sub(["8-K", "8-K"], ["2009-05-01", "2011-05-01"], ["2.02", "2.02"]),
    "https://data.test/submissions/CIK0000000003.json": sub(["8-K"], ["2012-07-01"], ["2.02"]),
    "https://data.test/submissions/CIK0000000004.json": sub(["8-K"], ["2013-01-01"], ["2.02"]),
  };
  const calls: { url: string; at: number; ua: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), at: Date.now(), ua: (init?.headers as Record<string, string>)["User-Agent"] });
    const body = pages[String(url)];
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  const opts = { ref, data, email: "me@example.com", rps: 10, fetchImpl, secBase: "https://sec.test", dataBase: "https://data.test", log: () => {} };
  const r = await fetchEarnings(opts);
  assert.ok(calls.every((c) => c.ua === "Stock_screener backtester me@example.com"));
  assert.ok(!calls.some((c) => c.url.endsWith("-002.json")), "files ending before 2003 are skipped");
  for (let k = 1; k < calls.length; k++) assert.ok(calls[k].at - calls[k - 1].at >= 95, "≤ 10 requests a second");
  const csv = readFileSync(join(ref, "earnings_dates.csv"), "utf8").trim().split("\n");
  assert.deepEqual(csv, ["ticker,cik,filing_date", "AAA,0000000001,2008-04-20", "BBB,0000000002,2009-05-01", "AAA,0000000001,2012-01-20", "BBB,0000000003,2012-07-01", "CCC,0000000004,2013-01-01"]);
  assert.deepEqual([r.tickers, r.matched, r.withEvents, r.events], [4, 3, 3, 5]);
  assert.match(readFileSync(join(ref, "earnings_coverage.csv"), "utf8"), /tickers_matched_to_cik,3[\s\S]*matched_via_massive_cik,2[\s\S]*2012,2,2/);
  const db = await Duck.open(":memory:");
  const [{ n }] = await db.all<{ n: number }>(`select count(*)::integer n from read_parquet(${lit(join(data, "earnings_dates.parquet"))})`);
  db.close();
  assert.equal(n, 5);
  // Resume: nothing left to download except the ticker map.
  calls.length = 0;
  await fetchEarnings(opts);
  assert.deepEqual(calls.map((c) => c.url), ["https://sec.test/files/company_tickers.json"]);
  await assert.rejects(fetchEarnings({ ...opts, email: "nope" }), /contact email/);
});

// 12 liquid stocks at $20. S0–S9 report on day `fd`; S10, S11 don't. Reaction (k − 5)% between the sessions
// before and after; afterwards S9 rises 1% a day and S0 falls 1% a day, the rest stay flat.
const D = weekdays("2018-01-01", 340);
function market(fd: number, extra?: { fd: number; react: (k: number) => number }) {
  const react = (k: number) => (k - 5) / 100;
  const price = (k: number, i: number) => {
    let p = 20;
    if (extra && k < 10 && i >= extra.fd) p *= 1 + extra.react(k);
    if (k >= 10 || i < fd) return p;
    p *= 1 + react(k);
    if (i <= fd + 1) return p;
    const g = k === 9 ? 0.01 : k === 0 ? -0.01 : 0;
    return p * (1 + g) ** (i - fd - 1);
  };
  const rows = D.flatMap((d, i) => Array.from({ length: 12 }, (_, k) => { const c = price(k, i); return { ...row(`S${k}`, d, c, c), dv: 25e6 }; }));
  const earnings = [
    ...Array.from({ length: 10 }, (_, k) => ({ ticker: `S${k}`, filing_date: D[fd] })),
    ...(extra ? Array.from({ length: 10 }, (_, k) => ({ ticker: `S${k}`, filing_date: D[extra.fd] })) : []),
  ];
  return { src: new MemorySource(rows, [], earnings), price };
}

test("earnings_drift (quarter): reaction around the filing, top / bottom 10%, all events, universe on signal days", async () => {
  const fd = 300;
  const { src, price } = market(fd);
  const r = await runEarningsStudy(src, { from: D[0], to: D[330], horizons: [1, 5], min_price: 10 });
  const ev = (t: string) => r.events.find((e) => e.ticker === t)!;
  assert.ok(Math.abs(ev("S7").react! - 0.02) < 1e-12);           // close after ÷ close before − 1
  assert.equal(D[ev("S7").i1], D[fd + 1]);
  assert.deepEqual(r.events.filter((e) => e.group === "top").map((e) => e.ticker), ["S9"]);
  assert.deepEqual(r.events.filter((e) => e.group === "bottom").map((e) => e.ticker), ["S0"]);
  const entry = fd + 2;                                             // open two sessions after the filing
  const fwd = (k: number, h: number) => price(k, entry + h - 1) / price(k, entry) - 1;
  const all = r.result.rows.at(-1)!;
  assert.equal(all.signals, 1);
  assert.ok(Math.abs(all.sig[1]! - fwd(9, 5)) < 1e-12);
  assert.ok(Math.abs(all.net[1]! - (fwd(9, 5) - 0.002)) < 1e-12);
  assert.ok(Math.abs(all.extra!.bottom.avg[1]! - fwd(0, 5)) < 1e-12);
  const allEv = Array.from({ length: 10 }, (_, k) => fwd(k, 5)).reduce((a, b) => a + b, 0) / 10;
  assert.ok(Math.abs(all.extra!.all_events.avg[1]! - allEv) < 1e-12);
  const uni = Array.from({ length: 12 }, (_, k) => fwd(k, 5)).reduce((a, b) => a + b, 0) / 12;
  assert.ok(Math.abs(all.base[1]! - uni) < 1e-12);                // the whole liquid universe entering that day
  assert.equal(all.baseline, 12);
  assert.ok(all.extra!.bottom_minus_all_events.avg[1]! < 0 && all.edge[1]! > 0);
  assert.match(r.eventsCsv().split("\n")[0], /^filing_date,ticker,reaction_day,reaction,group,entry_open,ret_1d,ret_5d$/);
});

test("earnings_drift (trailing): ranked only against earlier events in the window", async () => {
  // Day 240: ten small reactions (0.0%–0.9%), none ranked (nothing before them). Day 300: −5%…+4%, ranked against day 240's.
  const { src } = market(300, { fd: 240, react: (k) => k / 1000 });
  const r = await runEarningsStudy(src, { from: D[0], to: D[330], horizons: [1], rank_window: "trailing", trailing_days: 63, min_trailing_events: 5 });
  assert.ok(r.events.filter((e) => e.i1 === 241).every((e) => e.group === null));
  // Against 0.0%…0.9%: everything ≥ +1% is in the top 10%, everything ≤ 0% in the bottom 10%.
  const late = r.events.filter((e) => e.i1 === 301);
  assert.deepEqual(late.filter((e) => e.group === "top").map((e) => e.ticker).sort(), ["S6", "S7", "S8", "S9"]);
  assert.deepEqual(late.filter((e) => e.group === "bottom").map((e) => e.ticker).sort(), ["S0", "S1", "S2", "S3", "S4", "S5"]);
});
