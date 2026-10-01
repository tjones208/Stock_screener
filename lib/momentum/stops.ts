// Stops and exits (spec section 8). Pure; used by the daily job, the page and tests.
import type { MomConfig } from "./config.ts";
import { round2, stopDistance } from "./sizing.ts";

/** Stop_t = max(Stop_{t−1}, HC − D): trails the highest close since entry and never moves down. */
export const trailStop = (prevStop: number, highestClose: number, D: number) => Math.max(prevStop, round2(highestClose - D));

/** Broker GTC stop-market level: Stop_t − disaster_stop_extra × D. */
export const disasterStop = (stop: number, D: number, cfg: Pick<MomConfig, "disaster_stop_extra">) => round2(stop - cfg.disaster_stop_extra * D);

/**
 * Nightly trail that resizes with price: D_t = clamp(stop_atr_mult × ATR20_t, stop_min_pct × close_t,
 * stop_max_pct × close_t), Stop_t = max(Stop_{t−1}, HC − D_t), disaster = Stop_t − extra × D_t.
 * lots.d (the entry distance) stays the initial risk for R and sizing.
 */
export function nightlyStop(prevStop: number, highestClose: number, close: number, atr: number | null, entryD: number,
  cfg: Pick<MomConfig, "stop_atr_mult" | "stop_min_pct" | "stop_max_pct" | "disaster_stop_extra">) {
  // No ATR today (no snapshot row): fall back to the entry distance.
  const dTrail = atr != null && atr > 0 && close > 0 ? round2(stopDistance(atr, close, cfg)) : entryD;
  const stop = trailStop(prevStop, highestClose, dTrail);
  return { stop, dTrail, disaster: disasterStop(stop, dTrail, cfg) };
}

/** "Update GTC stop" when the broker order is unset or the new disaster stop is ≥ 2% above it (any day). */
export const gtcNeedsUpdate = (l: { disaster_stop: number; disaster_posted: number | null }) =>
  l.disaster_posted == null || l.disaster_stop >= l.disaster_posted * 1.02 - 1e-9;

export type Lot = { id: number; ticker: string; shares: number; fill_price: number; d: number; stop: number; filled_at: string; lt_date: string;
  lt_deferred_trigger?: number | null; lt_deferred_shares?: number | null };

export type Position = {
  ticker: string;
  lots: Lot[];
  close: number | null;        // close on the signal date (null = no bar: halted or delisted?)
  active: boolean;             // still listed
  holdOk: boolean | null;      // hold test on the signal date; null = no snapshot row
  holdReason?: string | null;  // why the hold test failed (e.g. "Possible pending buyout")
  buyoutNews: string | null;   // date of an open acquisition-agreement flag
  target: number | null;       // current target T (month-end only)
  entryOk: boolean;            // passes the entry test today (for top-ups)
  volTarget?: number | null;   // m × target for the volatility brake (weekly / monthly when m < vol_trim_trigger)
};

export type ExitOrder = {
  ticker: string;
  trigger: 1 | 2 | 3 | 4 | 5 | 7 | 9;
  lots: { id: number; shares: number }[];
  shares: number;
  reason: string;
  /** Triggers 1, 2, 4 and 5 must be out the same session they are worked. */
  urgent: boolean;
  deadlineDays: number;        // trading days allowed (0 = the next session)
};

export const TRIGGER_LABEL: Record<number, string> = {
  1: "Regime risk-off", 2: "Stop hit", 3: "Dropped off (failed hold test)", 4: "Acquisition agreement", 5: "Halt / delisting",
  6: "Buying power cut", 7: "Trim (over 2× target)", 8: "Called away (covered call)", 9: "Volatility brake",
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
    return full(3, p.holdOk === null ? "No ranking row on the signal date, so it can't pass the hold test."
      : `Failed the month-end hold test${p.holdReason ? `: ${p.holdReason.charAt(0).toLowerCase()}${p.holdReason.slice(1)}` : ""}.`, false);
  }
  if (p.buyoutNews) return full(4, `Acquisition-agreement news on ${p.buyoutNews}: sell within 5 trading days.`, true, 5);
  if (!p.active || p.close == null) return full(5, !p.active ? "No longer listed." : "No bar on the signal date: trading halt or delisting?", true);
  // Volatility brake: bring the position down to m × its target (weekly / monthly signals only).
  if (p.volTarget != null && p.close != null && total * p.close > p.volTarget + p.close) {
    const sell = total - p.volTarget / p.close;
    const lots = pickLots(p.lots, sell, p.close, ctx.cfg.fractional_shares);
    const shares = lots.reduce((s, l) => s + l.shares, 0);
    if (shares > 0) {
      return { ticker: p.ticker, trigger: 9, lots, shares, urgent: false, deadlineDays: 0,
        reason: `Volatility brake: market volatility is high, so trim from ${(total * p.close).toFixed(0)} to ${p.volTarget.toFixed(0)} (m × target).` };
    }
  }
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

/** Triggers that may wait for long-term treatment; 1 (regime), 2 (stop), 4 (buyout) and 5 (halt) never wait. */
export const LT_DEFERRABLE = new Set([3, 7, 9]);

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** A lot with a gain that turns long-term within lt_tax_window_days (and hasn't yet). */
export const ltWindow = (l: Pick<Lot, "fill_price" | "lt_date">, close: number, t: string, cfg: Pick<MomConfig, "lt_tax_window_days">) =>
  close > l.fill_price && t < l.lt_date && daysBetween(t, l.lt_date) <= cfg.lt_tax_window_days;

/**
 * Long-term deferral: for triggers 3, 7 and 9, lots in their LT window are held back until lt_date.
 * Returns the order for the remaining lots (or null) and the deferred lots with the shares each would
 * have sold.
 */
export function applyLtDeferral(order: ExitOrder | null, lots: Lot[], close: number | null, t: string, cfg: MomConfig) {
  if (!order || close == null || !LT_DEFERRABLE.has(order.trigger)) return { order, deferred: [] as { id: number; shares: number; lt_date: string }[] };
  const byId = new Map(lots.map((l) => [l.id, l]));
  const keep: { id: number; shares: number }[] = [], deferred: { id: number; shares: number; lt_date: string }[] = [];
  for (const x of order.lots) {
    const l = byId.get(x.id)!;
    if (ltWindow(l, close, t, cfg)) deferred.push({ ...x, lt_date: l.lt_date });
    else keep.push(x);
  }
  if (!deferred.length) return { order, deferred };
  const shares = keep.reduce((s, l) => s + l.shares, 0);
  const until = deferred.map((d) => d.lt_date).sort()[0];
  return {
    order: shares > 0 ? { ...order, lots: keep, shares, reason: `${order.reason} (${deferred.length} lot${deferred.length === 1 ? "" : "s"} deferred for LT until ${until})` } : null,
    deferred,
  };
}

/** Deferred lots whose wait is over: lt_date reached, or the gain is gone (nothing left to protect). */
export function dueDeferrals<L extends Lot>(lots: L[], close: number | null, t: string): L[] {
  return lots.filter((l) => l.lt_deferred_trigger != null && (t >= l.lt_date || (close != null && close <= l.fill_price)));
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
