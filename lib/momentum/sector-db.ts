import "server-only";
// Sector keys for the momentum caps, resolved from ss_tickers (GICS for S&P 500 names, else SIC).
import { db } from "../db";
import { momSector } from "./sector-key";

/** ticker → GICS sector key (see momSector). Tickers missing from ss_tickers get "unknown:TICKER". */
export async function tickerSectors(tickers: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(tickers)];
  const out = new Map<string, string>();
  // Chunked: a long .in() list would overflow the request URL.
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += 300) chunks.push(uniq.slice(i, i + 300));
  const results = await Promise.all(chunks.map((c) => db().from("ss_tickers").select("ticker, in_sp500, sector, sic_code").in("ticker", c)));
  for (const r of results) {
    if (r.error) throw new Error(`ss_tickers: ${r.error.message}`);
    for (const t of r.data ?? []) out.set(t.ticker, momSector(t));
  }
  for (const t of uniq) if (!out.has(t)) out.set(t, momSector({ ticker: t }));
  return out;
}

/** Attach `sector` to rows that carry a ticker. */
export async function withSectors<T extends { ticker: string }>(rows: T[]): Promise<(T & { sector: string })[]> {
  const m = await tickerSectors(rows.map((r) => r.ticker));
  return rows.map((r) => ({ ...r, sector: m.get(r.ticker)! }));
}
