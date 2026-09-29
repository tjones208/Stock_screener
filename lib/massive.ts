import "server-only";
import { env, envOr } from "./env";

// Massive (formerly Polygon.io) free Stocks Basic: 5 requests/minute, end-of-day data.
const MIN_GAP_MS = 12_500;
let lastCall = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    if (!res.ok) throw new Error(`Massive ${url.pathname} → ${res.status} ${await res.text()}`);
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
};

export async function tickerDetails(ticker: string): Promise<TickerDetails | null> {
  const r = await get<{ results?: TickerDetails }>(`/v3/reference/tickers/${encodeURIComponent(ticker)}`);
  return r.results ?? null;
}

type FinVal = { value?: number } | undefined;
export type FinancialReport = {
  end_date?: string;
  fiscal_period?: string;
  fiscal_year?: string;
  financials?: {
    income_statement?: Record<string, FinVal>;
    balance_sheet?: Record<string, FinVal>;
    cash_flow_statement?: Record<string, FinVal>;
  };
};

/** Last few quarterly reports (newest first). */
export async function financials(ticker: string, limit = 5): Promise<FinancialReport[]> {
  const r = await get<{ results?: FinancialReport[] }>("/vX/reference/financials", {
    ticker,
    timeframe: "quarterly",
    order: "desc",
    sort: "period_of_report_date",
    limit,
  });
  return r.results ?? [];
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
