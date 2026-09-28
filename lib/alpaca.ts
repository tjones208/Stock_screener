import "server-only";
import { env } from "./env";
import { parseOcc, type RawPut } from "./wheel";

// Alpaca paper account, free "indicative" options feed: delayed trades, modified quotes.
// Good enough to screen; confirm the real premium in Robinhood before trading.

function headers() {
  return {
    "APCA-API-KEY-ID": env("ALPACA_KEY_ID"),
    "APCA-API-SECRET-KEY": env("ALPACA_SECRET_KEY"),
    accept: "application/json",
  };
}

async function get<T>(url: URL): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: headers(), cache: "no-store" });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Alpaca ${url.pathname} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
  throw new Error(`Alpaca ${url.pathname} → rate limited`);
}

type Snapshot = {
  latestQuote?: { ap?: number; bp?: number };
  latestTrade?: { p?: number };
  greeks?: { delta?: number; theta?: number };
  impliedVolatility?: number;
};

type Contract = { symbol: string; open_interest?: string | null };

/** Open interest by contract symbol (from the trading API; snapshots don't carry OI). */
async function openInterest(ticker: string, expGte: string, expLte: string, strikeLte: number) {
  const oi = new Map<string, number>();
  let token: string | undefined;
  do {
    const url = new URL("https://paper-api.alpaca.markets/v2/options/contracts");
    url.searchParams.set("underlying_symbols", ticker);
    url.searchParams.set("type", "put");
    url.searchParams.set("status", "active");
    url.searchParams.set("expiration_date_gte", expGte);
    url.searchParams.set("expiration_date_lte", expLte);
    url.searchParams.set("strike_price_lte", String(strikeLte));
    url.searchParams.set("limit", "10000");
    if (token) url.searchParams.set("page_token", token);
    const r = await get<{ option_contracts?: Contract[]; next_page_token?: string | null }>(url);
    for (const c of r.option_contracts ?? []) {
      if (c.open_interest != null) oi.set(c.symbol, Number(c.open_interest));
    }
    token = r.next_page_token ?? undefined;
  } while (token);
  return oi;
}

/** Puts on `ticker` expiring in the window, with quotes, greeks, IV and OI. */
export async function putChain(
  ticker: string,
  underlying: number,
  expGte: string,
  expLte: string,
  strikeLte: number,
): Promise<RawPut[]> {
  const snaps: Record<string, Snapshot> = {};
  let token: string | undefined;
  do {
    const url = new URL(`https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(ticker)}`);
    url.searchParams.set("feed", "indicative");
    url.searchParams.set("type", "put");
    url.searchParams.set("expiration_date_gte", expGte);
    url.searchParams.set("expiration_date_lte", expLte);
    url.searchParams.set("strike_price_lte", String(strikeLte));
    url.searchParams.set("limit", "1000");
    if (token) url.searchParams.set("page_token", token);
    const r = await get<{ snapshots?: Record<string, Snapshot>; next_page_token?: string | null }>(url);
    Object.assign(snaps, r.snapshots ?? {});
    token = r.next_page_token ?? undefined;
  } while (token);

  if (!Object.keys(snaps).length) return [];
  const oi = await openInterest(ticker, expGte, expLte, strikeLte);

  const out: RawPut[] = [];
  for (const [symbol, s] of Object.entries(snaps)) {
    const occ = parseOcc(symbol);
    if (!occ || occ.side !== "put") continue;
    out.push({
      contract: symbol,
      ticker,
      expiration: occ.expiration,
      strike: occ.strike,
      underlying,
      bid: s.latestQuote?.bp ?? null,
      ask: s.latestQuote?.ap ?? null,
      last: s.latestTrade?.p ?? null,
      iv: s.impliedVolatility ?? null,
      delta: s.greeks?.delta ?? null,
      theta: s.greeks?.theta ?? null,
      openInterest: oi.get(symbol) ?? null,
      volume: null,
    });
  }
  return out;
}
