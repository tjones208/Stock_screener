// Stops and exits (spec section 8). Pure; used by the daily job, the page and tests.
import type { MomConfig } from "./config.ts";
import { round2 } from "./sizing.ts";

/** Stop_t = max(Stop_{t−1}, HC − D): trails the highest close since entry and never moves down. */
export const trailStop = (prevStop: number, highestClose: number, D: number) => Math.max(prevStop, round2(highestClose - D));

/** Broker GTC stop-market level: Stop_t − disaster_stop_extra × D. */
export const disasterStop = (stop: number, D: number, cfg: Pick<MomConfig, "disaster_stop_extra">) => round2(stop - cfg.disaster_stop_extra * D);

export type Lot = { id: number; ticker: string; shares: number; fill_price: number; d: number; stop: number; filled_at: string; lt_date: string };

export type Position = {
  ticker: string;
  lots: Lot[];
  close: number | null;        // close on the signal date (null = no bar: halted or delisted?)
  active: boolean;             // still listed
  holdOk: boolean | null;      // hold test on the signal date; null = not in the universe
  buyoutNews: string | null;   // date of an open acquisition-agreement flag
  target: number | null;       // current target T (month-end only)
  entryOk: boolean;            // passes the entry test today (for top-ups)
};

export type ExitOrder = {
  ticker: string;
  trigger: 1 | 2 | 3 | 4 | 5 | 7;
  lots: { id: number; shares: number }[];
  shares: number;
  reason: string;
  /** Triggers 1, 2, 4 and 5 must be out the same session they are worked. */
  urgent: boolean;
  deadlineDays: number;        // trading days allowed (0 = the next session)
};

export const TRIGGER_LABEL: Record<number, string> = {
  1: "Regime risk-off", 2: "Stop hit", 3: "Dropped off (failed hold test)", 4: "Acquisition agreement", 5: "Halt / delisting",
  6: "Buying power cut", 7: "Trim (over 2× target)", 8: "Called away (covered call)",
};

/** Lot order for partial sales: losing lots first, then highest cost (HIFO). */
export function sellOrder(lots: Lot[], price: number): Lot[] {
  return [...lots].sort((a, b) => {
    const la = a.fill_price > price ? 0 : 1, lb = b.fill_price > price ? 0 : 1;
    return la - lb || b.fill_price - a.fill_price;
  });
}

/** Take `shares` from lots in sell order (whole lots first, the last one partially). */
export function pickLots(lots: Lot[], shares: number, price: number, fractional: boolean) {
  const out: { id: number; shares: number }[] = [];
  let left = shares;
  for (const l of sellOrder(lots, price)) {
    if (left <= 1e-9) break;
    const take = Math.min(l.shares, left);
    out.push({ id: l.id, shares: fractional ? Math.round(take * 1000) / 1000 : Math.floor(take + 1e-9) });
    left -= take;
  }
  return out.filter((x) => x.shares > 0);
}

/**
 * Exit review for one position, triggers evaluated in spec order; the first that applies wins.
 * Month-end-only triggers (1, 3, 7) are checked only when `monthEnd` is true.
 */
export function reviewPosition(p: Position, ctx: { monthEnd: boolean; riskOn: boolean | null; cfg: MomConfig }): ExitOrder | null {
  const all = p.lots.map((l) => ({ id: l.id, shares: l.shares }));
  const total = p.lots.reduce((s, l) => s + l.shares, 0);
  const full = (trigger: ExitOrder["trigger"], reason: string, urgent: boolean, deadlineDays = 0): ExitOrder =>
    ({ ticker: p.ticker, trigger, lots: all, shares: total, reason, urgent, deadlineDays });

  if (ctx.monthEnd && ctx.riskOn === false) return full(1, "SPY closed the month below its 10-month average: sell everything.", true);
  if (p.close != null) {
    const hit = p.lots.filter((l) => p.close! <= l.stop);
    if (hit.length) {
      return {
        ticker: p.ticker, trigger: 2, lots: hit.map((l) => ({ id: l.id, shares: l.shares })), shares: hit.reduce((s, l) => s + l.shares, 0),
        reason: `Closed ${p.close.toFixed(2)} at or below the stop ${Math.max(...hit.map((l) => l.stop)).toFixed(2)}.`, urgent: true, deadlineDays: 0,
      };
    }
  }
  if (ctx.monthEnd && p.holdOk !== true) {
    return full(3, p.holdOk === null ? "Dropped out of the universe, so it can't pass the hold test." : "Failed the month-end hold test.", false);
  }
  if (p.buyoutNews) return full(4, `Acquisition-agreement news on ${p.buyoutNews}: sell within 5 trading days.`, true, 5);
  if (!p.active || p.close == null) return full(5, !p.active ? "No longer listed." : "No bar on the signal date: trading halt or delisting?", true);
  if (ctx.monthEnd && p.target != null && p.close != null) {
    const value = total * p.close;
    if (value > ctx.cfg.trim_trigger_mult * p.target) {
      const keep = (ctx.cfg.trim_to_mult * p.target) / p.close;
      const sell = total - keep;
      const lots = pickLots(p.lots, sell, p.close, ctx.cfg.fractional_shares);
      const shares = lots.reduce((s, l) => s + l.shares, 0);
      if (shares > 0) {
        return { ticker: p.ticker, trigger: 7, lots, shares, reason: `Worth ${value.toFixed(0)}, over ${ctx.cfg.trim_trigger_mult}× its target ${p.target.toFixed(0)}: trim to ${ctx.cfg.trim_to_mult}×.`, urgent: false, deadlineDays: 0 };
      }
    }
  }
  return null;
}

/** Month-end top-up: shares to bring a position back to target when it's under topup_below_mult × T and passes entry tests. */
export function topUpShares(p: Position, cfg: MomConfig): number {
  if (p.target == null || p.close == null || !p.entryOk) return 0;
  const total = p.lots.reduce((s, l) => s + l.shares, 0);
  const value = total * p.close;
  if (value >= cfg.topup_below_mult * p.target) return 0;
  const add = (p.target - value) / p.close;
  return cfg.fractional_shares ? Math.floor(add * 1000) / 1000 : Math.floor(add);
}

/** record-exit numbers for one lot (or the sold part of it). */
export function exitResult(l: { fill_price: number; d: number; lt_date: string }, X: number, shares: number, fees: number, exitDay: string) {
  return {
    pnl: round2((X - l.fill_price) * shares - fees),
    r: Math.round(((X - l.fill_price) / l.d) * 100) / 100,
    term: exitDay >= l.lt_date ? "LT" : "ST",
  };
}
