// Covered calls on momentum positions (pure, tested). You sell calls in your broker and record them
// here; the app says which positions have round lots of 100 shares and which expirations fit: on or
// before the next month-end rebalance and before earnings, so a call never blocks a scheduled exit.
import type { MomConfig } from "./config.ts";
import { isMonthEnd, nextTradingDay, type Calendar } from "./calendar.ts";

/** Contracts that can still be written: floor(shares / 100) minus contracts already open. */
export const coverableContracts = (shares: number, openContracts: number) => Math.max(0, Math.floor(shares / 100 + 1e-9) - openContracts);

/** Last trading day of the month `d` falls in. */
export function monthEndOf(cal: Calendar, d: string): string {
  let x = d;
  while (!isMonthEnd(cal, x)) x = nextTradingDay(cal, x);
  return x;
}

/**
 * Expirations allowed when selling on `today`: at least call_min_dte days out, on or before this
 * month's last trading day (the next rebalance signal), and before the next earnings date.
 * Null when that leaves no room (late in the month, or earnings too close).
 */
export function callWindow(cal: Calendar, today: string, earnings: string | null, cfg: Pick<MomConfig, "call_min_dte">) {
  const monthEnd = monthEndOf(cal, today);
  let lte = monthEnd;
  if (earnings && earnings > today && earnings <= lte) {
    const dayBefore = new Date(Date.parse(earnings + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
    lte = dayBefore;
  }
  const gte = new Date(Date.parse(today + "T00:00:00Z") + cfg.call_min_dte * 86_400_000).toISOString().slice(0, 10);
  return gte <= lte ? { gte, lte, monthEnd } : null;
}

/**
 * Before selling shares, the calls that must be bought back first: all of them for a full exit;
 * for a partial sale, enough that the remaining shares still cover what stays open.
 */
export function callsToClose(sharesHeld: number, sharesToSell: number, openContracts: number): number {
  const remaining = sharesHeld - sharesToSell;
  return Math.max(0, openContracts - Math.floor(remaining / 100 + 1e-9));
}

/** OCC symbol for a call, e.g. DRH 2026-10-30 14 → "DRH261030C00014000". */
export function occCall(ticker: string, expiration: string, strike: number): string {
  const [y, m, d] = expiration.split("-");
  return `${ticker}${y.slice(2)}${m}${d}C${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}
