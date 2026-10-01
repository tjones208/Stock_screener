import "server-only";
import { db, fetchAll, upsertChunks } from "./db";
import { dailyRange, financials, groupedDaily, listTickers, tickerDetails, type FinancialReport } from "./massive";
import { evaluateRules, type AlertRule } from "./alerts";
import { cleanFilters, dbConditions, type Filters, type ScreenerRow } from "./screen";
import { pushAll } from "./push";
import { addDays, nyToday, weekdaysBack } from "./dates";
import { sectorFromSic } from "./sectors";

// Which bars we keep: common stocks, ETFs and ADRs priced ≥ $1 (no upper cap), plus anything on a
// watchlist. Strategies apply their own price/volume floors on top (oversold: ≥ $5, ≥ 1M avg volume).
const KEEP_TYPES = new Set(["CS", "ETF", "ADRC"]);
const MIN_PRICE = 1;
/** Bars above this were skipped before the cap was removed; the backfill fills them in once. */
const OLD_MAX_PRICE = 75;
const HISTORY_DAYS = 400;
/** Liquid names (the momentum pool) keep more history: 273+ trading days plus holidays and slack. */
export const LONG_HISTORY_DAYS = 460;
/** Market-regime benchmark for strategies that require SPY above its 200-day SMA. */
export const REGIME_TICKER = "SPY";

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

/**
 * Load one trading day of whole-market bars (one API call). Returns rows kept.
 * `onlyAboveOldCap` is the one-time fill for days loaded while bars above $75 were skipped:
 * it inserts just those bars and never rewrites existing rows (no table bloat).
 */
export async function ingestDay(
  date: string,
  types?: Map<string, string | null>,
  watch?: Set<string>,
  onlyAboveOldCap = false,
  only?: Set<string>,
) {
  types ??= await tickerTypes();
  watch ??= await watchlistTickers();
  const bars = await groupedDaily(date);
  const keep = bars.filter((b) => {
    if (onlyAboveOldCap && !(b.c > OLD_MAX_PRICE)) return false;
    if (watch!.has(b.T)) return true;
    if (only && !only.has(b.T)) return false;
    if (b.c < MIN_PRICE) return false;
    if (types!.size) return KEEP_TYPES.has(types!.get(b.T) ?? "");
    return /^[A-Z]{1,5}$/.test(b.T); // before the first ticker sync: plain symbols only
  });
  const rows = keep.map((b) => ({ ticker: b.T, d: date, o: b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v), vw: b.vw ?? null, n: b.n ?? null }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await db().from("ss_daily_bars")
      .upsert(rows.slice(i, i + 1000), { onConflict: "ticker,d", ignoreDuplicates: onlyAboveOldCap });
    if (error) throw new Error(`ss_daily_bars: ${error.message}`);
  }
  const marker = onlyAboveOldCap
    ? db().from("ss_loaded_days").update({ full_universe: true }).eq("d", date)
    : db().from("ss_loaded_days").upsert({ d: date, rows: keep.length, loaded_at: new Date().toISOString(), full_universe: true });
  const { error } = await marker;
  if (error) throw new Error(`ss_loaded_days: ${error.message}`);
  return keep.length;
}

export async function longHistoryTickers(): Promise<Set<string>> {
  const rows = await fetchAll<{ ticker: string }>((a, b) => db().rpc("ss_long_history_tickers").range(a, b));
  return new Set(rows.map((r) => r.ticker));
}

/** Make sure the regime benchmark has full history (one range call instead of waiting for the fill). */
async function ensureRegimeHistory(today: string): Promise<number> {
  const { count } = await db().from("ss_daily_bars").select("d", { count: "exact", head: true }).eq("ticker", REGIME_TICKER);
  if ((count ?? 0) >= 250) return 0;
  const bars = await dailyRange(REGIME_TICKER, addDays(today, -HISTORY_DAYS), addDays(today, -1));
  const rows = bars.map((b) => ({ ticker: REGIME_TICKER, d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v), vw: b.vw ?? null, n: b.n ?? null }));
  await upsertChunks("ss_daily_bars", rows, "ticker,d");
  return rows.length;
}

/** Fill in missing history, newest first, until the time budget runs out. Safe to call repeatedly. */
export async function backfill(budgetMs = 270_000) {
  const left = deadline(budgetMs);
  const today = nyToday();
  const wanted = weekdaysBack(addDays(today, 1), LONG_HISTORY_DAYS);
  const shortCutoff = addDays(today, -HISTORY_DAYS);
  const { data: loaded } = await db().from("ss_loaded_days").select("d").gte("d", wanted[wanted.length - 1]);
  const have = new Set((loaded ?? []).map((r) => r.d as string));
  const missing = wanted.filter((d) => !have.has(d) && d < today); // today's bars load in the nightly job
  const types = await tickerTypes();
  const watch = await watchlistTickers();
  const regimeBars = await ensureRegimeHistory(today);
  const done: string[] = [];
  let longSet: Set<string> | undefined;
  for (const d of missing) {
    if (left() < 20_000) break;
    // Days beyond the normal horizon only keep the liquid (long-history) names.
    if (d < shortCutoff) longSet ??= await longHistoryTickers();
    await ingestDay(d, types, watch, false, d < shortCutoff ? longSet : undefined);
    done.push(d);
  }
  // One-time fill of bars above the old $75 cap for days loaded before it was removed.
  const { data: partial } = await db().from("ss_loaded_days").select("d").eq("full_universe", false).order("d", { ascending: false });
  let filled = 0;
  for (const { d } of partial ?? []) {
    if (left() < 20_000) break;
    await ingestDay(d as string, types, watch, true);
    done.push(d as string);
    filled++;
  }
  let indicators: number | null = null;
  if (done.length) {
    // A full refresh can exceed the API gateway timeout; queue it inside Postgres instead.
    const { error } = await db().rpc("ss_queue_maintenance");
    if (error) throw new Error(`ss_queue_maintenance: ${error.message}`);
    indicators = -1; // refreshed by the database within a minute
  }
  return {
    loaded: done.length - filled,
    remaining: missing.length - (done.length - filled),
    aboveOldCapFilled: filled,
    aboveOldCapRemaining: (partial?.length ?? 0) - filled,
    regimeBars,
    indicators,
  };
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
  // Indicators and pruning run inside Postgres at 10:10 UTC (ss_nightly_maintenance via pg_cron):
  // the refresh takes longer than the API gateway allows for one request.
  return { date, rows };
}

export async function loadScreener(): Promise<ScreenerRow[]> {
  return fetchAll<ScreenerRow>((a, b) => db().from("ss_screener").select("*").order("ticker").range(a, b));
}

/**
 * Screener rows for one set of filters: the column filters run in the database, and the pages are
 * fetched in parallel. The caller still runs applyFilters() for the rules the database can't express.
 */
export async function loadScreenerFor(filters: Filters): Promise<ScreenerRow[]> {
  const conds = dbConditions(filters);
  const build = <Q extends { gte: Function; lte: Function; eq: Function }>(q: Q): Q => {
    for (const c of conds) {
      q = (q[c.op] as Function).call(q, c.col, c.value);
    }
    return q;
  };
  const { count, error } = await build(db().from("ss_screener").select("ticker", { count: "exact", head: true }));
  if (error) throw new Error(error.message);
  const PAGE = 1000;
  const pages = Math.ceil((count ?? 0) / PAGE);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      build(db().from("ss_screener").select("*")).order("ticker").range(i * PAGE, i * PAGE + PAGE - 1),
    ),
  );
  const rows: ScreenerRow[] = [];
  for (const r of results) {
    if (r.error) throw new Error(r.error.message);
    rows.push(...((r.data ?? []) as ScreenerRow[]));
  }
  return rows;
}

/** Latest EOD date and how many tickers it covers (cheap: one indexed lookup + a head count). */
export async function screenerSummary(): Promise<{ asOf: string | null; tickers: number }> {
  const { data } = await db().from("ss_indicators").select("as_of").order("as_of", { ascending: false }).limit(1);
  const asOf = (data?.[0]?.as_of as string | undefined) ?? null;
  if (!asOf) return { asOf: null, tickers: 0 };
  const { count } = await db().from("ss_indicators").select("ticker", { count: "exact", head: true }).eq("as_of", asOf);
  return { asOf, tickers: count ?? 0 };
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
  const { data: bench } = await db().from("ss_indicators").select("close, sma200, as_of").eq("ticker", REGIME_TICKER).maybeSingle();
  const regime = bench ? { ticker: REGIME_TICKER, ...bench } : null;
  const hits = evaluateRules(rules as AlertRule[], rows, { watchlists, screens: screenMap, regime });
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
      composite_figi: details?.composite_figi ?? null,
      updated_at: new Date().toISOString(),
    }).eq("ticker", ticker);
    // Non-S&P names take their sector from SIC (recomputed each fetch so mapping fixes apply);
    // S&P names keep their GICS sector and industry.
    await db().from("ss_tickers")
      .update({ sector: sectorFromSic(details?.sic_code), industry: details?.sic_description ?? null })
      .eq("ticker", ticker).eq("in_sp500", false);

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
