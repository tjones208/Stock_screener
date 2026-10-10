// Historical earnings dates from SEC EDGAR (run on your own machine; needs internet access to sec.gov).
//
// 1. Tickers → CIKs: first the CIK on each Massive reference ticker (tickers.jsonl, which includes
//    delisted companies), then https://www.sec.gov/files/company_tickers.json for the rest (that file
//    only knows current tickers).
// 2. Per CIK: https://data.sec.gov/submissions/CIK##########.json and the older filing files it lists
//    (only those reaching back past `since`). Every 8-K whose items include 2.02 ("Results of Operations
//    and Financial Condition") is an earnings release; its filing date is the earnings date.
// 3. A ticker reused by different companies gets each company's filings only up to that listing's
//    delisting date.
//
// SEC rules: a descriptive User-Agent with a contact email, and at most 10 requests a second (default 8).
// Resumable: finished CIKs are cached in <ref>/sec-earnings-cache.jsonl.
// Output: <data>/earnings_dates.parquet and <ref>/earnings_dates.csv (ticker, cik, filing_date), and
// <ref>/earnings_coverage.csv (tickers matched, events per year).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duck, lit } from "./duck.ts";

export type EarningsOptions = {
  ref: string; data?: string; email: string; rps?: number; since?: string;
  /** Ticker types to look up (default common stock). */
  types?: string[];
  log?: (s: string) => void;
  onProgress?: (done: number, total: number) => void;
  /** For tests: replaces fetch and the SEC hosts. */
  fetchImpl?: typeof fetch; secBase?: string; dataBase?: string;
};

type Filings = { form?: string[]; filingDate?: string[]; items?: string[] };
type Submissions = { cik?: string; filings?: { recent?: Filings; files?: { name: string; filingFrom?: string; filingTo?: string }[] } };

const pad = (cik: string | number) => String(cik).replace(/\D/g, "").padStart(10, "0");

/** Filing dates of 8-Ks with item 2.02 in one filings block. */
export function earningsFilings(f: Filings | undefined): string[] {
  if (!f?.form || !f.filingDate) return [];
  const out: string[] = [];
  for (let k = 0; k < f.form.length; k++) {
    if (f.form[k] !== "8-K") continue;
    const items = String(f.items?.[k] ?? "").split(/[,\s]+/);
    if (items.includes("2.02")) out.push(f.filingDate[k]);
  }
  return out;
}

export async function fetchEarnings(o: EarningsOptions) {
  const log = o.log ?? console.log;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw new Error("SEC requires a contact email in the User-Agent: set one (Data tab → Earnings dates).");
  const doFetch = o.fetchImpl ?? fetch;
  const secBase = o.secBase ?? "https://www.sec.gov", dataBase = o.dataBase ?? "https://data.sec.gov";
  const since = o.since ?? "2003-01-01";
  const gap = 1000 / Math.min(o.rps ?? 8, 10);
  const headers = { "User-Agent": `Stock_screener backtester ${o.email}`, "Accept-Encoding": "gzip, deflate", Accept: "application/json" };
  let lastCall = 0, requests = 0;
  async function get<T>(url: string): Promise<T | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = lastCall + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      requests++;
      const res = await doFetch(url, { headers });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      if (!res.ok) throw new Error(`${url} → ${res.status} ${(await res.text()).slice(0, 200)}${res.status === 403 ? " (SEC blocks requests without a proper User-Agent or above 10 a second)" : ""}`);
      return (await res.json()) as T;
    }
    throw new Error(`${url}: too many retries`);
  }

  // Tickers to cover, with every CIK Massive knows for them (a ticker can have been several companies).
  const tfile = join(o.ref, "tickers.jsonl");
  if (!existsSync(tfile)) throw new Error(`No ${tfile}: download reference data first.`);
  const types = new Set(o.types ?? ["CS"]);
  type Listing = { ticker: string; cik: string | null; delisted: string | null };
  const listings: Listing[] = [];
  for (const line of readFileSync(tfile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const t = JSON.parse(line) as { ticker?: string; type?: string; cik?: string; delisted_utc?: string | null };
    if (!t.ticker || (t.type && !types.has(t.type))) continue;
    listings.push({ ticker: t.ticker, cik: t.cik ? pad(t.cik) : null, delisted: t.delisted_utc ? t.delisted_utc.slice(0, 10) : null });
  }
  const tickers = [...new Set(listings.map((l) => l.ticker))];
  log(`${tickers.length.toLocaleString()} tickers (${[...types].join(", ")}) in the reference data.`);

  const fromMassive = new Set(listings.filter((l) => l.cik).map((l) => l.ticker)).size;
  // Fallback map from the SEC's current ticker file.
  const secMap = new Map<string, string>();
  const ct = await get<Record<string, { cik_str: number; ticker: string }>>(`${secBase}/files/company_tickers.json`);
  for (const v of Object.values(ct ?? {})) secMap.set(v.ticker.toUpperCase(), pad(v.cik_str));
  for (const t of tickers) {
    if (listings.some((l) => l.ticker === t && l.cik)) continue;
    const cik = secMap.get(t.toUpperCase()) ?? secMap.get(t.toUpperCase().replace(".", "-"));
    if (cik) for (const l of listings) if (l.ticker === t && !l.cik) l.cik = cik;
  }
  const matched = new Set(listings.filter((l) => l.cik).map((l) => l.ticker));
  log(`Matched ${matched.size.toLocaleString()} of ${tickers.length.toLocaleString()} tickers to a CIK (${((matched.size / Math.max(tickers.length, 1)) * 100).toFixed(1)}%).`);

  // Per-CIK earnings filing dates, cached so a stopped download resumes.
  const cacheFile = join(o.ref, "sec-earnings-cache.jsonl");
  const cache = new Map<string, string[]>();
  if (existsSync(cacheFile)) for (const line of readFileSync(cacheFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const x = JSON.parse(line) as { cik: string; dates: string[] }; cache.set(x.cik, x.dates); } catch { /* a cut-off last line */ }
  }
  const ciks = [...new Set(listings.map((l) => l.cik).filter((c): c is string => !!c))];
  const todo = ciks.filter((c) => !cache.has(c));
  log(`${ciks.length.toLocaleString()} companies; ${cache.size.toLocaleString()} already downloaded, ${todo.length.toLocaleString()} to go (about ${Math.ceil((todo.length * 1.3 * gap) / 60000)} min at ${(1000 / gap).toFixed(0)} requests a second).`);
  for (const [k, cik] of todo.entries()) {
    if (o.onProgress && k % 25 === 0) o.onProgress(k, todo.length);
    const sub = await get<Submissions>(`${dataBase}/submissions/CIK${cik}.json`);
    const dates = earningsFilings(sub?.filings?.recent);
    for (const f of sub?.filings?.files ?? []) {
      if (f.filingTo && f.filingTo < since) continue;
      const older = await get<Filings>(`${dataBase}/submissions/${f.name}`);
      dates.push(...earningsFilings(older ?? undefined));
    }
    const uniq = [...new Set(dates)].sort();
    cache.set(cik, uniq);
    appendFileSync(cacheFile, JSON.stringify({ cik, dates: uniq }) + "\n");
    if ((k + 1) % 500 === 0) log(`  ${(k + 1).toLocaleString()} of ${todo.length.toLocaleString()} companies…`);
  }
  o.onProgress?.(todo.length, todo.length);

  // (ticker, cik, filing_date), each listing's filings up to its delisting date.
  const rows: { ticker: string; cik: string; filing_date: string }[] = [];
  const seen = new Set<string>();
  for (const l of listings) {
    if (!l.cik) continue;
    for (const d of cache.get(l.cik) ?? []) {
      if (l.delisted && d > l.delisted) continue;
      const key = `${l.ticker}|${d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ticker: l.ticker, cik: l.cik, filing_date: d });
    }
  }
  rows.sort((a, b) => a.filing_date.localeCompare(b.filing_date) || a.ticker.localeCompare(b.ticker));
  const csv = ["ticker,cik,filing_date", ...rows.map((r) => `${r.ticker},${r.cik},${r.filing_date}`)].join("\n") + "\n";
  writeFileSync(join(o.ref, "earnings_dates.csv"), csv);
  if (o.data) {
    mkdirSync(o.data, { recursive: true });
    const db = await Duck.open(":memory:");
    try {
      await db.run(`copy (select ticker::varchar ticker, cik::varchar cik, filing_date::date filing_date from read_csv(${lit(join(o.ref, "earnings_dates.csv"))}, header = true, columns = {'ticker': 'varchar', 'cik': 'varchar', 'filing_date': 'date'}))
        to ${lit(join(o.data, "earnings_dates.parquet"))} (format parquet)`);
    } finally { db.close(); }
  }

  // Coverage: tickers matched, tickers with any earnings filing, events per year.
  const byYear = new Map<string, { events: number; tickers: Set<string> }>();
  for (const r of rows) {
    const y = r.filing_date.slice(0, 4);
    const v = byYear.get(y) ?? { events: 0, tickers: new Set<string>() };
    v.events++; v.tickers.add(r.ticker);
    byYear.set(y, v);
  }
  const withEvents = new Set(rows.map((r) => r.ticker)).size;
  const cov = [
    "metric,value",
    `tickers,${tickers.length}`, `tickers_matched_to_cik,${matched.size}`, `matched_pct,${(matched.size / Math.max(tickers.length, 1)).toFixed(4)}`,
    `matched_via_massive_cik,${fromMassive}`, `tickers_with_earnings_filings,${withEvents}`, `companies,${ciks.length}`, `events,${rows.length}`, `sec_requests,${requests}`,
    "", "year,events,tickers",
    ...[...byYear.keys()].sort().map((y) => `${y},${byYear.get(y)!.events},${byYear.get(y)!.tickers.size}`),
  ].join("\n") + "\n";
  writeFileSync(join(o.ref, "earnings_coverage.csv"), cov);
  log(`Earnings dates: ${rows.length.toLocaleString()} events for ${withEvents.toLocaleString()} tickers (${matched.size.toLocaleString()} of ${tickers.length.toLocaleString()} tickers matched to a CIK).`);
  for (const y of [...byYear.keys()].sort()) log(`  ${y}: ${byYear.get(y)!.events.toLocaleString()} events, ${byYear.get(y)!.tickers.size.toLocaleString()} tickers`);
  return { tickers: tickers.length, matched: matched.size, withEvents, events: rows.length, byYear: Object.fromEntries([...byYear].map(([y, v]) => [y, { events: v.events, tickers: v.tickers.size }])), requests };
}
