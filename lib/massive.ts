import "server-only";
import { env, envOr } from "./env";

// Massive (formerly Polygon.io) free Stocks Basic: 5 requests/minute, end-of-day data.
const MIN_GAP_MS = 12_500;
let lastCall = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { MassiveError, isNotFound } from "./fundamentals-calc";
import { MassiveError } from "./fundamentals-calc";

async function get<T>(pathOrUrl: string, params: Record<string, string | number> = {}): Promise<T> {
  const base = envOr("MASSIVE_BASE_URL", "https://api.massive.com");
  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("apiKey", env("MASSIVE_API_KEY"));

  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 429) {
      await sleep(MIN_GAP_MS * 2);
      continue;
    }
    if (!res.ok) {
      const sunset = [res.headers.get("sunset") && `sunset ${res.headers.get("sunset")}`, res.headers.get("link")].filter(Boolean).join("; ");
      throw new MassiveError(res.status, `Massive ${url.pathname} → ${res.status} ${(await res.text()).slice(0, 300)}${sunset ? ` [${sunset}]` : ""}`);
    }
    if (res.headers.get("deprecation")) console.warn(`Massive ${url.pathname} is deprecated: sunset ${res.headers.get("sunset")} ${res.headers.get("link") ?? ""}`);
    return (await res.json()) as T;
  }
  throw new Error(`Massive ${url.pathname} → rate limited`);
}

/** Seconds until the next call is allowed — lets jobs stop before running out of time. */
export function massiveCallCost(): number {
  return MIN_GAP_MS;
}

export type GroupedBar = { T: string; o: number; h: number; l: number; c: number; v: number; vw?: number; n?: number; t: number };

/** Whole-market daily bars for one date (YYYY-MM-DD). Empty on holidays/weekends. */
export async function groupedDaily(date: string): Promise<GroupedBar[]> {
  const r = await get<{ results?: GroupedBar[] }>(
    `/v2/aggs/grouped/locale/us/market/stocks/${date}`,
    { adjusted: "true" },
  );
  return r.results ?? [];
}

export type RefTicker = { ticker: string; name: string; type?: string; primary_exchange?: string; active: boolean };

/** All active US stock tickers with their type (CS, ETF, ...). ~12 paged calls. */
export async function listTickers(): Promise<RefTicker[]> {
  const out: RefTicker[] = [];
  let next: string | undefined = "/v3/reference/tickers";
  let params: Record<string, string | number> = { market: "stocks", active: "true", limit: 1000 };
  while (next) {
    const r: { results?: RefTicker[]; next_url?: string } = await get(next, params);
    out.push(...(r.results ?? []));
    next = r.next_url;
    params = {}; // next_url already carries the cursor
  }
  return out;
}

export type TickerDetails = {
  ticker: string;
  name?: string;
  market_cap?: number;
  sic_code?: string;
  sic_description?: string;
  share_class_shares_outstanding?: number;
  weighted_shares_outstanding?: number;
  type?: string;
  primary_exchange?: string;
  composite_figi?: string;
};

export async function tickerDetails(ticker: string): Promise<TickerDetails | null> {
  const r = await get<{ results?: TickerDetails }>(`/v3/reference/tickers/${encodeURIComponent(ticker)}`);
  return r.results ?? null;
}

// Fundamentals (successor to the retired /vX/reference/financials, sunset 2026-10-09): flat
// statement rows per period from /stocks/financials/v1/*.
export type IncomeStatement = {
  period_end?: string; fiscal_year?: number; fiscal_quarter?: number; timeframe?: string;
  revenue?: number; gross_profit?: number; operating_income?: number; net_income_loss_attributable_common_shareholders?: number;
  consolidated_net_income_loss?: number; diluted_earnings_per_share?: number; basic_earnings_per_share?: number;
};
export type BalanceSheet = {
  period_end?: string; total_equity_attributable_to_parent?: number; total_equity?: number; total_liabilities?: number;
  total_current_assets?: number; total_current_liabilities?: number;
};

/** Last few quarterly income statements (newest first). */
export async function incomeStatements(ticker: string, limit = 5): Promise<IncomeStatement[]> {
  const r = await get<{ results?: IncomeStatement[] }>("/stocks/financials/v1/income-statements", {
    tickers: ticker, timeframe: "quarterly", sort: "period_end.desc", limit,
  });
  return r.results ?? [];
}

/** Latest quarterly balance sheet. */
export async function balanceSheet(ticker: string): Promise<BalanceSheet | null> {
  const r = await get<{ results?: BalanceSheet[] }>("/stocks/financials/v1/balance-sheets", {
    tickers: ticker, timeframe: "quarterly", sort: "period_end.desc", limit: 1,
  });
  return r.results?.[0] ?? null;
}

/** One ticker's daily bars between two dates (inclusive), oldest first. One API call. */
export async function dailyRange(ticker: string, from: string, to: string): Promise<{ d: string; o: number; h: number; l: number; c: number; v: number; vw?: number; n?: number }[]> {
  const r = await get<{ results?: (Omit<GroupedBar, "T">)[] }>(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`,
    { adjusted: "true", sort: "asc", limit: 50000 },
  );
  const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
  return (r.results ?? []).map((b) => ({ d: nyDate.format(new Date(b.t)), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw, n: b.n }));
}

/** Paged GET that follows next_url (the cursor already carries every other parameter). */
async function getAll<T>(path: string, params: Record<string, string | number>, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  let p = params;
  for (let i = 0; next && i < maxPages; i++) {
    const r: { results?: T[]; next_url?: string } = await get(next, p);
    out.push(...(r.results ?? []));
    next = r.next_url;
    p = {};
  }
  return out;
}

export type Split = { ticker: string; execution_date: string; split_from: number; split_to: number };

/** Splits executed on or after `from` (whole market). */
export function splitsSince(from: string): Promise<Split[]> {
  return getAll<Split>("/v3/reference/splits", { "execution_date.gte": from, order: "asc", sort: "execution_date", limit: 1000 });
}

export type MarketHoliday = { date: string; exchange: string; name: string; status: string };

export async function upcomingHolidays(): Promise<MarketHoliday[]> {
  const r = await get<MarketHoliday[]>("/v1/marketstatus/upcoming");
  return Array.isArray(r) ? r : [];
}

export type NewsArticle = { title: string; tickers?: string[]; published_utc: string; article_url: string };

/** One ticker's news between two UTC dates (oldest first). */
export function newsForTicker(ticker: string, from: string, to: string): Promise<NewsArticle[]> {
  return getAll<NewsArticle>("/v2/reference/news", {
    ticker, "published_utc.gte": `${from}T00:00:00Z`, "published_utc.lt": `${to}T00:00:00Z`,
    order: "asc", sort: "published_utc", limit: 1000,
  }, 5);
}

/** All news published on one UTC calendar day (whole market). */
export function newsForDay(day: string, nextDay: string): Promise<NewsArticle[]> {
  return getAll<NewsArticle>("/v2/reference/news", {
    "published_utc.gte": `${day}T00:00:00Z`, "published_utc.lt": `${nextDay}T00:00:00Z`,
    order: "asc", sort: "published_utc", limit: 1000,
  });
}
