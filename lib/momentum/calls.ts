// Covered calls on momentum positions (pure, tested). Calls are only written against shares the
// strategy already holds in round lots of 100, far out of the money, and expire before the next
// month-end rebalance (and before earnings) so they never block a scheduled exit.
import type { MomConfig } from "./config.ts";
import { isMonthEnd, nextTradingDay, type Calendar } from "./calendar.ts";
import type { RawPut } from "../wheel.ts";

/** Contracts that can still be written: floor(shares / 100) minus contracts already open. */
export const coverableContracts = (shares: number, openContracts: number) => Math.max(0, Math.floor(shares / 100 + 1e-9) - openContracts);

/** Last trading day of the month `d` falls in. */
export function monthEndOf(cal: Calendar, d: string): string {
  let x = d;
  while (!isMonthEnd(cal, x)) x = nextTradingDay(cal, x);
  return x;
}

const days = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

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

export type CallPick = RawPut & { mid: number; dte: number; spreadPct: number };

/**
 * The call to sell: out of the money, delta inside [call_delta_min, call_delta_max], liquid enough.
 * Prefers the latest allowed expiration (most premium for the month), then the delta closest to
 * the top of the band, then the higher bid.
 */
export function pickCall(chain: RawPut[], underlying: number, today: string, window: { gte: string; lte: string },
  cfg: Pick<MomConfig, "call_delta_min" | "call_delta_max" | "call_min_open_interest" | "call_min_bid" | "call_max_spread_pct">): CallPick | null {
  const ok: CallPick[] = [];
  for (const c of chain) {
    if (c.expiration < window.gte || c.expiration > window.lte || !(c.strike > underlying)) continue;
    if (c.delta == null || c.delta < cfg.call_delta_min || c.delta > cfg.call_delta_max) continue;
    if (c.bid == null || c.ask == null || c.bid < cfg.call_min_bid || c.ask < c.bid) continue;
    const mid = (c.bid + c.ask) / 2;
    const spreadPct = (c.ask - c.bid) / mid;
    if (spreadPct > cfg.call_max_spread_pct) continue;
    if (c.openInterest != null && c.openInterest < cfg.call_min_open_interest) continue;
    ok.push({ ...c, mid, dte: days(today, c.expiration), spreadPct });
  }
  ok.sort((a, b) => b.expiration.localeCompare(a.expiration) || (b.delta ?? 0) - (a.delta ?? 0) || (b.bid ?? 0) - (a.bid ?? 0));
  return ok[0] ?? null;
}

/**
 * Before selling shares, the calls that must be bought back first: all of them for a full exit;
 * for a partial sale, enough that the remaining shares still cover what stays open.
 */
export function callsToClose(sharesHeld: number, sharesToSell: number, openContracts: number): number {
  const remaining = sharesHeld - sharesToSell;
  return Math.max(0, openContracts - Math.floor(remaining / 100 + 1e-9));
}
