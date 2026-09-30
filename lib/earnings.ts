// Earnings calendar helpers (pure, tested). Rows come from Finnhub's /calendar/earnings.

export type FinnhubEarning = { date?: string; symbol?: string; hour?: string; epsEstimate?: number | null; quarter?: number; year?: number };
export type EarningsRow = { ticker: string; report_date: string; hour: string | null; eps_estimate: number | null; source: "finnhub" };

const HOURS: Record<string, string> = { bmo: "before open", amc: "after close", dmh: "during market" };

/** Normalize Finnhub rows: valid symbol + date only, one row per (ticker, date). */
export function parseFinnhub(rows: FinnhubEarning[]): EarningsRow[] {
  const out = new Map<string, EarningsRow>();
  for (const r of rows) {
    const ticker = (r.symbol ?? "").trim().toUpperCase();
    const d = r.date ?? "";
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    out.set(`${ticker}|${d}`, {
      ticker, report_date: d, hour: r.hour && HOURS[r.hour] ? HOURS[r.hour] : null,
      eps_estimate: typeof r.epsEstimate === "number" ? r.epsEstimate : null, source: "finnhub",
    });
  }
  return [...out.values()];
}

/** Consecutive [from, to] windows of `days` calendar days covering from..to inclusive. */
export function dateWindows(from: string, to: string, days = 7): [string, string][] {
  const add = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
  const out: [string, string][] = [];
  for (let a = from; a <= to; a = add(a, days)) {
    const b = add(a, days - 1);
    out.push([a, b < to ? b : to]);
  }
  return out;
}
