// Cash, open lots and closed lots for one backtest. Prices are split-adjusted throughout, so share
// counts stay consistent across splits; dividends arrive as cash per adjusted share.
import type { ClosedLot, Lot } from "./types.ts";

const DAY = 86_400_000;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** Long-term date: entry + 1 year + 1 day (held more than one year). */
export function ltDateOf(d: string) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCFullYear(x.getUTCFullYear() + 1);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

export type LotOrder = "hifo" | "fifo" | "loss_first";

export class Portfolio {
  cash: number;
  lots: Lot[] = [];
  closed: ClosedLot[] = [];
  dividends = 0;
  dividendsByYear = new Map<string, number>();
  commissions = 0;
  private nextId = 1;

  constructor(cash: number) {
    this.cash = cash;
  }

  lotsOf(ticker: string) {
    return this.lots.filter((l) => l.ticker === ticker);
  }

  sharesOf(ticker: string) {
    return this.lotsOf(ticker).reduce((a, l) => a + l.shares, 0);
  }

  tickers() {
    return [...new Set(this.lots.map((l) => l.ticker))];
  }

  /** Buy: a new lot. A wash-sale flag is set when the ticker was sold at a loss in the 30 days before. */
  buy(ticker: string, shares: number, price: number, d: string, commission = 0, tag?: string): Lot {
    const wash = this.closed.some((c) => c.ticker === ticker && c.pnl < 0 && c.exitD <= d && dayDiff(c.exitD, d) <= 30);
    const lot: Lot = { id: this.nextId++, ticker, shares, price, d, ltDate: ltDateOf(d), wash, tag };
    this.cash -= shares * price + commission;
    this.commissions += commission;
    this.lots.push(lot);
    return lot;
  }

  /** Sell explicit lots (or part of them). Returns the closed pieces. */
  sellLots(picks: { id: number; shares: number }[], price: number, d: string, commission = 0, exitTag?: string): ClosedLot[] {
    const out: ClosedLot[] = [];
    const total = picks.reduce((a, p) => a + p.shares, 0);
    for (const p of picks) {
      const lot = this.lots.find((l) => l.id === p.id);
      if (!lot || p.shares <= 0) continue;
      const shares = Math.min(p.shares, lot.shares);
      const fee = total ? (commission * shares) / total : 0;
      const pnl = (price - lot.price) * shares - fee;
      out.push({
        id: lot.id, ticker: lot.ticker, shares, entry: lot.price, exit: price, entryD: lot.d, exitD: d, pnl,
        ret: price / lot.price - 1, days: dayDiff(lot.d, d), term: d >= lot.ltDate ? "LT" : "ST", tag: lot.tag, exitTag, wash: lot.wash,
      });
      this.cash += shares * price - fee;
      lot.shares -= shares;
    }
    this.commissions += commission;
    this.lots = this.lots.filter((l) => l.shares > 1e-9);
    // Wash sale on the other side: a loss sale with the same stock bought in the 30 days before.
    for (const c of out) {
      if (c.pnl >= 0) continue;
      for (const l of this.lots) if (l.ticker === c.ticker && l.d <= d && dayDiff(l.d, d) <= 30) l.wash = true;
    }
    this.closed.push(...out);
    return out;
  }

  /** Sell `shares` of a ticker (or all), choosing lots in the given order. */
  sell(ticker: string, shares: number | "all", price: number, d: string, order: LotOrder = "hifo", commission = 0, exitTag?: string) {
    const lots = this.lotsOf(ticker);
    const want = shares === "all" ? lots.reduce((a, l) => a + l.shares, 0) : shares;
    const sorted = [...lots].sort((a, b) =>
      order === "fifo" ? a.d.localeCompare(b.d)
      : order === "loss_first" ? (a.price > price ? 0 : 1) - (b.price > price ? 0 : 1) || b.price - a.price
      : b.price - a.price);
    const picks: { id: number; shares: number }[] = [];
    let left = want;
    for (const l of sorted) {
      if (left <= 1e-9) break;
      const take = Math.min(l.shares, left);
      picks.push({ id: l.id, shares: take });
      left -= take;
    }
    return this.sellLots(picks, price, d, commission, exitTag);
  }

  /** Dividend with ex-date d: paid on shares bought before d. */
  dividend(ticker: string, cashPerShare: number, d: string) {
    const shares = this.lotsOf(ticker).filter((l) => l.d < d).reduce((a, l) => a + l.shares, 0);
    const amt = shares * cashPerShare;
    this.cash += amt;
    this.dividends += amt;
    this.dividendsByYear.set(d.slice(0, 4), (this.dividendsByYear.get(d.slice(0, 4)) ?? 0) + amt);
    return amt;
  }

  value(close: (ticker: string) => number | undefined) {
    return this.lots.reduce((a, l) => a + l.shares * (close(l.ticker) ?? l.price), 0);
  }
}
