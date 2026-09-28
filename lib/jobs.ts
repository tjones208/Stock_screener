import "server-only";
import { db, fetchAll, upsertChunks } from "./db";
import { financials, groupedDaily, listTickers, tickerDetails, type FinancialReport } from "./massive";
import { putChain } from "./alpaca";
import { rankPuts, DEFAULT_WHEEL } from "./wheel";
import { evaluateRules, type AlertRule } from "./alerts";
import { cleanFilters, type Filters, type ScreenerRow } from "./screen";
import { pushAll } from "./push";
import { addDays, nyToday, weekdaysBack } from "./dates";
import { sectorFromSic } from "./sectors";

// Which bars we keep (storage budget): stocks/ETFs priced $1–$75, plus anything on a watchlist.
const KEEP_TYPES = new Set(["CS", "ETF", "ADRC"]);
const MIN_PRICE = 1;
const MAX_PRICE = 75;
const HISTORY_DAYS = 400;

const deadline = (ms: number) => {
  const end = Date.now() + ms;
  return () => end - Date.now();
};

async function watchlistTickers(): Promise<Set<string>> {
  const rows = await fetchAll<{ ticker: string }>((a, b) => db().from("ss_watchlist_items").select("ticker").range(a, b));
  return new Set(rows.map((r) => r.ticker));
}

// ───────────── Reference data (weekly) ─────────────

const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

async function sp500(): Promise<Map<string, { sector: string; industry: string }>> {
  const out = new Map<string, { sector: string; industry: string }>();
  try {
    const res = await fetch(SP500_CSV, { cache: "no-store" });
    if (!res.ok) return out;
    const lines = (await res.text()).trim().split("\n").slice(1);
    for (const line of lines) {
      // Symbol,Security,GICS Sector,GICS Sub-Industry,... (fields may be quoted)
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "")) ?? [];
      if (cells[0]) out.set(cells[0], { sector: cells[2], industry: cells[3] });
    }
  } catch {
    /* optional source */
  }
  return out;
}

export async function syncTickers() {
  const [all, spx] = await Promise.all([listTickers(), sp500()]);
  const rows = all.map((t) => ({
    ticker: t.ticker,
    name: t.name,
    type: t.type ?? null,
    exchange: t.primary_exchange ?? null,
    active: t.active,
    in_sp500: spx.has(t.ticker),
    ...(spx.has(t.ticker) ? { sector: spx.get(t.ticker)!.sector, industry: spx.get(t.ticker)!.industry } : {}),
    updated_at: new Date().toISOString(),
  }));
  await upsertChunks("ss_tickers", rows, "ticker");
  // Tickers that disappeared from the active list
  const active = new Set(all.map((t) => t.ticker));
  const known = await fetchAll<{ ticker: string }>((a, b) => db().from("ss_tickers").select("ticker").eq("active", true).range(a, b));
  const gone = known.map((k) => k.ticker).filter((t) => !active.has(t));
  for (let i = 0; i < gone.length; i += 200) {
    await db().from("ss_tickers").update({ active: false }).in("ticker", gone.slice(i, i + 200));
  }
  return { tickers: rows.length, sp500: spx.size, deactivated: gone.length };
}

// ───────────── Daily bars ─────────────

async function tickerTypes(): Promise<Map<string, string | null>> {
  const rows = await fetchAll<{ ticker: string; type: string | null }>((a, b) =>
    db().from("ss_tickers").select("ticker, type").eq("active", true).range(a, b),
  );
  return new Map(rows.map((r) => [r.ticker, r.type]));
}

/** Load one trading day of whole-market bars (one API call). Returns rows kept. */
export async function ingestDay(date: string, types?: Map<string, string | null>, watch?: Set<string>) {
  types ??= await tickerTypes();
  watch ??= await watchlistTickers();
  const bars = await groupedDaily(date);
  const keep = bars.filter((b) => {
    if (watch!.has(b.T)) return true;
    if (b.c < MIN_PRICE || b.c > MAX_PRICE) return false;
    if (types!.size) return KEEP_TYPES.has(types!.get(b.T) ?? "");
    return /^[A-Z]{1,5}$/.test(b.T); // before the first ticker sync: plain symbols only
  });
  await upsertChunks(
    "ss_daily_bars",
    keep.map((b) => ({ ticker: b.T, d: date, o: b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v), vw: b.vw ?? null, n: b.n ?? null })),
    "ticker,d",
  );
  await db().from("ss_loaded_days").upsert({ d: date, rows: keep.length, loaded_at: new Date().toISOString() });
  return keep.length;
}

/** Fill in missing history, newest first, until the time budget runs out. Safe to call repeatedly. */
export async function backfill(budgetMs = 270_000) {
  const left = deadline(budgetMs);
  const today = nyToday();
  const wanted = weekdaysBack(addDays(today, 1), HISTORY_DAYS);
  const { data: loaded } = await db().from("ss_loaded_days").select("d").gte("d", wanted[wanted.length - 1]);
  const have = new Set((loaded ?? []).map((r) => r.d as string));
  const missing = wanted.filter((d) => !have.has(d) && d < today); // today's bars load in the nightly job
  const types = await tickerTypes();
  const watch = await watchlistTickers();
  const done: string[] = [];
  for (const d of missing) {
    if (left() < 20_000) break;
    await ingestDay(d, types, watch);
    done.push(d);
  }
  if (done.length) await db().rpc("ss_refresh_indicators");
  return { loaded: done.length, remaining: missing.length - done.length };
}

/**
 * Morning job: load the previous trading day's bars → indicators → prune.
 * Massive's free plan refuses a day's grouped bars until well after the close
 * ("Attempted to request today's data before end of day"), so this runs early the next
 * morning (≈ 6am ET) and loads the prior weekday. Holidays come back empty and are skipped.
 */
export async function nightlyEod() {
  const date = weekdaysBack(nyToday(), 7)[0]; // most recent weekday before today (NY time)
  const rows = await ingestDay(date);
  if (rows === 0) return { date, rows, note: "no bars (holiday or not published yet)" };
  const { data: updated, error } = await db().rpc("ss_refresh_indicators", { p_as_of: date });
  if (error) throw new Error(error.message);
  const { data: pruned } = await db().rpc("ss_prune_bars", { p_days: HISTORY_DAYS });
  return { date, rows, indicators: updated, pruned };
}

// ───────────── Options scan ─────────────

export async function scanOptions(budgetMs = 270_000, limit = 150) {
  const left = deadline(budgetMs);
  const { data: latest } = await db().from("ss_indicators").select("as_of").order("as_of", { ascending: false }).limit(1);
  const found = latest?.[0]?.as_of as string | undefined;
  if (!found) return { scanned: 0, note: "no indicators yet" };
  const asOf: string = found;

  const watch = await watchlistTickers();
  const { data: liquid } = await db()
    .from("ss_indicators")
    .select("ticker, close, avg_vol20")
    .eq("as_of", asOf)
    .gte("close", 5)
    .lte("close", DEFAULT_WHEEL.maxCollateral / 100)
    .gte("avg_vol20", 500_000)
    .order("avg_vol20", { ascending: false })
    .limit(limit * 2);
  const { data: watchRows } = watch.size
    ? await db().from("ss_indicators").select("ticker, close, avg_vol20").in("ticker", [...watch])
    : { data: [] };

  // Skip names we already know have no options; watchlist names always get scanned.
  const { data: noOpt } = await db().from("ss_tickers").select("ticker").eq("has_options", false);
  const skip = new Set((noOpt ?? []).map((r) => r.ticker));
  const seen = new Set<string>();
  const universe: { ticker: string; close: number }[] = [];
  for (const r of [...(watchRows ?? []), ...(liquid ?? [])]) {
    if (seen.has(r.ticker)) continue;
    if (!watch.has(r.ticker) && (skip.has(r.ticker) || universe.length >= limit)) continue;
    seen.add(r.ticker);
    universe.push({ ticker: r.ticker, close: r.close });
  }

  const expGte = addDays(asOf, DEFAULT_WHEEL.minDte);
  const expLte = addDays(asOf, DEFAULT_WHEEL.maxDte);
  let scanned = 0, candidates = 0;
  const errors: string[] = [];
  const queue = [...universe];

  async function worker() {
    while (queue.length && left() > 15_000) {
      const u = queue.shift()!;
      try {
        const strikeCap = Math.min(u.close, DEFAULT_WHEEL.maxCollateral / 100);
        const chain = await putChain(u.ticker, u.close, expGte, expLte, strikeCap);
        await db().from("ss_tickers").update({ has_options: chain.length > 0 }).eq("ticker", u.ticker);
        const ranked = rankPuts(chain, asOf).slice(0, 5);
        if (ranked.length) {
          const { error } = await db().from("ss_option_candidates").upsert(
            ranked.map((p) => ({
              as_of: asOf, ticker: p.ticker, contract: p.contract, side: p.side, expiration: p.expiration,
              dte: p.dte, strike: p.strike, underlying: p.underlying, bid: p.bid, ask: p.ask, mid: p.mid,
              last: p.last, iv: p.iv, delta: p.delta, theta: p.theta, open_interest: p.openInterest,
              volume: p.volume, spread_pct: p.spreadPct, otm_pct: p.otmPct, collateral: p.collateral,
              annual_yield: p.annualYield, score: p.score,
            })),
            { onConflict: "as_of,contract" },
          );
          if (error) throw new Error(error.message);
          candidates += ranked.length;
        }
        scanned++;
      } catch (e) {
        errors.push(`${u.ticker}: ${String(e).slice(0, 120)}`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  await db().from("ss_option_candidates").delete().lt("as_of", addDays(asOf, -30));
  return { asOf, universe: universe.length, scanned, candidates, errors: errors.slice(0, 10) };
}

// ───────────── Alerts ─────────────

export async function loadScreener(): Promise<ScreenerRow[]> {
  return fetchAll<ScreenerRow>((a, b) => db().from("ss_screener").select("*").order("ticker").range(a, b));
}

export async function runAlerts() {
  const [{ data: rules }, { data: items }, { data: screens }, rows] = await Promise.all([
    db().from("ss_alert_rules").select("*").eq("enabled", true),
    db().from("ss_watchlist_items").select("watchlist_id, ticker"),
    db().from("ss_screens").select("id, filters"),
    loadScreener(),
  ]);
  if (!rules?.length || !rows.length) return { rules: rules?.length ?? 0, hits: 0, pushed: 0 };

  const watchlists = new Map<number, Set<string>>();
  for (const i of items ?? []) {
    if (!watchlists.has(i.watchlist_id)) watchlists.set(i.watchlist_id, new Set());
    watchlists.get(i.watchlist_id)!.add(i.ticker);
  }
  const screenMap = new Map<number, Filters>((screens ?? []).map((s) => [s.id, cleanFilters(s.filters)]));
  const hits = evaluateRules(rules as AlertRule[], rows, { watchlists, screens: screenMap });
  const day = rows[0].as_of;

  const { data: inserted, error } = await db()
    .from("ss_alert_events")
    .upsert(hits.map((h) => ({ ...h, triggered_on: day })), { onConflict: "rule_id,ticker,triggered_on", ignoreDuplicates: true })
    .select("id, message");
  if (error) throw new Error(error.message);

  let pushed = 0;
  const fresh = inserted ?? [];
  if (fresh.length) {
    const body = fresh.slice(0, 4).map((e) => e.message).join("\n") + (fresh.length > 4 ? `\n+${fresh.length - 4} more` : "");
    pushed = await pushAll(fresh.length === 1 ? "Screener alert" : `${fresh.length} screener alerts`, body);
    await db().from("ss_alert_events").update({ pushed_at: new Date().toISOString() }).in("id", fresh.map((e) => e.id));
  }
  return { rules: rules.length, hits: hits.length, new: fresh.length, pushed };
}

// ───────────── Fundamentals (rolling, 5 calls/min) ─────────────

const val = (x: { value?: number } | undefined) => (x?.value == null ? null : x.value);
const sum4 = (reports: FinancialReport[], stmt: "income_statement" | "cash_flow_statement", key: string) => {
  const vals = reports.slice(0, 4).map((r) => val(r.financials?.[stmt]?.[key]));
  return vals.length === 4 && vals.every((v) => v != null) ? (vals as number[]).reduce((a, b) => a + b, 0) : null;
};
const ratio = (a: number | null, b: number | null, pct = false) =>
  a == null || b == null || b === 0 ? null : (a / b) * (pct ? 100 : 1);

export async function fundamentalsBatch(count = 2) {
  const { data: queue } = await db().from("ss_fundamentals_queue").select("ticker").limit(count);
  const done: string[] = [];
  for (const { ticker } of queue ?? []) {
    const [details, reports] = [await tickerDetails(ticker), await financials(ticker)];
    const { data: ind } = await db().from("ss_indicators").select("close").eq("ticker", ticker).maybeSingle();
    const close = ind?.close ?? null;

    const q0 = reports[0];
    const bs = q0?.financials?.balance_sheet;
    const revenue = sum4(reports, "income_statement", "revenues");
    const netIncome = sum4(reports, "income_statement", "net_income_loss");
    const gross = sum4(reports, "income_statement", "gross_profit");
    const opInc = sum4(reports, "income_statement", "operating_income_loss");
    const eps = sum4(reports, "income_statement", "diluted_earnings_per_share") ?? sum4(reports, "income_statement", "basic_earnings_per_share");
    const equity = val(bs?.equity_attributable_to_parent) ?? val(bs?.equity);
    const liabilities = val(bs?.liabilities);
    const revQ0 = val(q0?.financials?.income_statement?.revenues);
    const revQ4 = val(reports[4]?.financials?.income_statement?.revenues);
    const marketCap = details?.market_cap ?? null;

    await db().from("ss_tickers").update({
      market_cap: marketCap,
      shares_out: details?.weighted_shares_outstanding ?? details?.share_class_shares_outstanding ?? null,
      sic_code: details?.sic_code ?? null,
      updated_at: new Date().toISOString(),
    }).eq("ticker", ticker);
    // Only fill sector/industry from SIC when we have nothing better (S&P names carry GICS).
    await db().from("ss_tickers")
      .update({ sector: sectorFromSic(details?.sic_code), industry: details?.sic_description ?? null })
      .eq("ticker", ticker).is("sector", null);

    await db().from("ss_fundamentals").upsert({
      ticker,
      period_end: q0?.end_date ?? null,
      fiscal_period: q0 ? `${q0.fiscal_period ?? ""} ${q0.fiscal_year ?? ""}`.trim() : null,
      revenue_ttm: revenue,
      revenue_growth_yoy: revQ0 != null && revQ4 ? ((revQ0 - revQ4) / Math.abs(revQ4)) * 100 : null,
      net_income_ttm: netIncome,
      eps_ttm: eps,
      pe: close != null && eps != null && eps > 0 ? close / eps : null,
      ps: ratio(marketCap, revenue),
      pb: equity != null && equity > 0 ? ratio(marketCap, equity) : null,
      gross_margin: ratio(gross, revenue, true),
      operating_margin: ratio(opInc, revenue, true),
      net_margin: ratio(netIncome, revenue, true),
      roe: equity != null && equity > 0 ? ratio(netIncome, equity, true) : null,
      debt_to_equity: equity != null && equity > 0 ? ratio(liabilities, equity) : null,
      current_ratio: ratio(val(bs?.current_assets), val(bs?.current_liabilities)),
      raw: { details, latest: q0 ?? null },
      fetched_at: new Date().toISOString(),
    }, { onConflict: "ticker" });
    done.push(ticker);
  }
  return { fetched: done };
}
