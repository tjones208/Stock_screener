// Core types shared by the data layer, the engine and strategies.

/**
 * One ticker on one trading day: split-adjusted OHLCV plus precomputed features (see
 * data/prepare.ts). Feature fields are null until a ticker has enough history.
 */
export type Row = {
  ticker: string;
  d: string;            // YYYY-MM-DD
  o: number; h: number; l: number; c: number; v: number;
  dv: number;           // unadjusted close × volume (dollar volume)
  n: number;            // bars in the trailing ~420 calendar days (capped; enough for every feature)
  first_d: string;      // first date this ticker has a bar in the data set
  ret1: number | null;  // 1-day return
  ret21: number | null; ret63: number | null; ret126: number | null; ret252: number | null;
  mom_12_1: number | null;          // close 21 bars ago / close 252 bars ago − 1
  sma20: number | null; sma50: number | null; sma200: number | null;
  hi252: number | null; lo252: number | null; days_since_high: number | null;
  vol20: number | null; vol63: number | null; vol252: number | null;  // annualized σ of log returns
  atr14: number | null; atr20: number | null;
  avg_dv20: number | null; median_dv60: number | null;
};

/** Static ticker reference (from Massive's tickers list, including delisted names). */
export type TickerInfo = {
  ticker: string; name: string | null; type: string | null; exchange: string | null;
  active: boolean; delisted: string | null; sic_code: string | null;
};

export type Dividend = { ticker: string; ex_date: string; cash: number }; // cash per split-adjusted share

/** An order placed after a close; it is worked at the next session's open. */
export type BuyOrder = {
  side: "buy"; ticker: string;
  /** Shares to buy, or a function of the actual fill price (e.g. re-size at the real limit). */
  shares: number | ((price: number) => number);
  /** Limit price: fills at the open if the open is at or under it, else at the limit if the low reaches it. */
  limit?: number;
  /**
   * Stop and target for the bought shares, from the fill price, worked the same session after the
   * open (see SellOrder.stop/target; no gap check: the shares were bought at that open).
   */
  exits?: (price: number) => { stop?: number; target?: number } | null;
  tag?: string;
};
export type SellOrder = {
  side: "sell"; ticker: string;
  /** "all", a share count (lots chosen by `lotOrder`), or explicit lots. */
  shares: number | "all";
  lots?: { id: number; shares: number }[];
  /**
   * With a stop and/or target the order is conditional and lasts one session, worked after the
   * open's market orders: open at or under the stop → sells at the open; low reaches the stop →
   * at the stop; open at or over the target → at the open; high reaches the target → at the
   * target. The stop is checked first (conservative). Not triggered → it expires; place it again.
   */
  stop?: number;
  target?: number;
  tag?: string;
};
export type Order = BuyOrder | SellOrder;

export type Fill = { d: string; side: "buy" | "sell"; ticker: string; shares: number; price: number; tag?: string; lotId?: number };
export type Unfilled = { d: string; order: Order; reason: "no_bar" | "limit" | "cash" | "zero_shares" };

export type Lot = { id: number; ticker: string; shares: number; price: number; d: string; ltDate: string; wash: boolean; tag?: string };
export type ClosedLot = {
  id: number; ticker: string; shares: number; entry: number; exit: number; entryD: string; exitD: string;
  pnl: number; ret: number; days: number; term: "ST" | "LT"; tag?: string; exitTag?: string; wash: boolean;
};

export type EquityPoint = { d: string; equity: number; cash: number; invested: number; positions: number };
