// In-memory DataSource for engine tests.
import type { DataSource } from "../src/engine/engine.ts";
import type { Dividend, Row, TickerInfo } from "../src/engine/types.ts";

export function row(ticker: string, d: string, o: number, c: number, extra: Partial<Row> = {}): Row {
  return {
    ticker, d, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1e6, dv: c * 1e6, n: 300, first_d: "2000-01-01",
    ret1: null, ret21: null, ret63: null, ret126: null, ret252: null, mom_12_1: null, sma20: null, sma50: null, sma200: null,
    hi252: null, lo252: null, days_since_high: null, vol20: null, vol63: null, vol252: null, atr14: null, atr20: null,
    avg_dv20: null, median_dv60: null, ...extra,
  };
}

export class MemorySource implements DataSource {
  private byDay = new Map<string, Map<string, Row>>();
  private divs = new Map<string, Dividend[]>();
  private tk = new Map<string, TickerInfo>();
  constructor(rows: Row[], divs: Dividend[] = []) {
    for (const r of rows) {
      if (!this.byDay.has(r.d)) this.byDay.set(r.d, new Map());
      this.byDay.get(r.d)!.set(r.ticker, r);
      if (!this.tk.has(r.ticker)) this.tk.set(r.ticker, { ticker: r.ticker, name: null, type: "CS", exchange: "XNYS", active: true, delisted: null, sic_code: null });
    }
    for (const d of divs) this.divs.set(d.ex_date, [...(this.divs.get(d.ex_date) ?? []), d]);
  }
  days() { return [...this.byDay.keys()].sort(); }
  tickers() { return this.tk; }
  dividends() { return this.divs; }
  async rows(from: string, to: string) {
    return new Map([...this.byDay].filter(([d]) => d >= from && d <= to));
  }
}

/** Weekday dates from a start date. */
export function weekdays(from: string, n: number) {
  const out: string[] = [];
  for (const d = new Date(from + "T00:00:00Z"); out.length < n; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10));
  return out;
}
