// Order-ticket math (spec 7 execution, 8 exit prices, record-fill). Pure; used by jobs, page and tests.
import type { MomConfig } from "./config.ts";
import { positionShares, round2, stopDistance } from "./sizing.ts";

/**
 * Buy limits from the 09:45 quote: LP1 = min(mid + ¼ spread, Cap), LP2 = min(ask, Cap).
 * When the ask is already above the cap there is no buy today (retry tomorrow with the same cap).
 */
export function buyLimits(bid: number, ask: number, cap: number) {
  if (!(bid > 0) || !(ask >= bid)) return { error: "Enter a bid and an ask (ask ≥ bid)." } as const;
  if (ask > cap) return { noBuy: true, reason: `Ask ${ask.toFixed(2)} is above the cap ${cap.toFixed(2)}: no buy today; retry next session with the same cap.` } as const;
  const mid = (bid + ask) / 2;
  const lp1 = Math.min(round2(mid + 0.25 * (ask - bid)), cap);
  const lp2 = Math.min(round2(ask), cap);
  return { noBuy: false, lp1, lp2 } as const;
}

/** Exit limits: XP1 = mid − ¼ spread, XP2 = bid (then a market order after 30 minutes in total). */
export function exitLimits(bid: number, ask: number) {
  const mid = (bid + ask) / 2;
  return { xp1: round2(mid - 0.25 * (ask - bid)), xp2: round2(bid) };
}

/** Shares at an actual limit price (6.6): min(floor(T / LP), floor(risk budget / D)), D taken at LP. */
export function sharesAt(T: number, LP: number, atr: number, cfg: MomConfig) {
  const D = stopDistance(atr, LP, cfg);
  return { D, ...positionShares(T, LP, D, cfg) };
}

export type TicketState = {
  status: "open" | "alternate" | "filled" | "dropped" | "cancelled";
  retry_day: number;
  trade_date: string | null;
  s_close: number;
  cap: number;
  note?: string | null;
};

/**
 * Carry an unfilled buy ticket into the next session. On retry day `entry_retry_reset_day` the entry
 * test is re-run on the latest close: fail, or a close above the original cap → drop (the next
 * alternate takes the slot); otherwise keep the original S and cap (never reset upward). After
 * `entry_max_retry_days` sessions unfilled → drop.
 */
export function advanceTicket(
  t: TicketState,
  tradeDay: string,
  latest: { entry_ok: boolean; close: number } | null,
  cfg: Pick<MomConfig, "entry_retry_reset_day" | "entry_max_retry_days" | "chase_cap_pct">,
): TicketState & { promote: boolean } {
  if (t.status !== "open" || !t.trade_date || t.trade_date >= tradeDay) return { ...t, promote: false };
  const day = t.retry_day + 1;
  if (day > cfg.entry_max_retry_days) {
    return { ...t, status: "dropped", note: `Unfilled after ${cfg.entry_max_retry_days} sessions`, promote: true };
  }
  if (day === cfg.entry_retry_reset_day) {
    if (!latest?.entry_ok) return { ...t, status: "dropped", note: `Failed the entry re-check on retry day ${day}`, promote: true };
    if (latest.close > t.cap) {
      return { ...t, status: "dropped", note: `Closed ${latest.close.toFixed(2)} above the cap ${t.cap.toFixed(2)} on retry day ${day}: not chasing it`, promote: true };
    }
    return { ...t, retry_day: day, trade_date: tradeDay, note: `Still under the cap on retry day ${day}; S and cap unchanged`, promote: false };
  }
  return { ...t, retry_day: day, trade_date: tradeDay, promote: false };
}

/** Values stored when a fill is recorded: D (fixed), Stop0, disaster stop, long-term date. */
export function fillLevels(F: number, atrAtSignal: number, filledOn: string, cfg: MomConfig) {
  const D = round2(stopDistance(atrAtSignal, F, cfg));
  const stop0 = round2(F - D);
  const disaster = round2(stop0 - cfg.disaster_stop_extra * D);
  // Long-term: entry date + 1 year + 1 calendar day.
  const y = new Date(filledOn + "T00:00:00Z");
  y.setUTCFullYear(y.getUTCFullYear() + 1);
  y.setUTCDate(y.getUTCDate() + 1);
  return { D, stop0, disaster, ltDate: y.toISOString().slice(0, 10) };
}
