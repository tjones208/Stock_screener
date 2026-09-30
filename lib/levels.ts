// Mechanical entry / stop / target levels for each strategy, from end-of-day data.
// These are rule-based trade plans for the next session, not predictions: every level
// comes from today's high/low/close, ATR(14), VWAP or moving averages as described per rule.
import type { ScreenerRow } from "./screen.ts";

export type Levels = {
  side: "Long" | "Short";
  /** Price that triggers the trade (a buy/sell-stop above/below, or a limit for reversion). */
  entry: number;
  /** Where the idea is wrong. */
  stop: number;
  /** Profit-taking level. */
  target: number;
  /** Reward ÷ risk. */
  rr: number | null;
  /** How the entry is triggered, in a few words. */
  how: string;
  /**
   * Next-open strategies: the entry is a market-on-open order on T+1, taken only if the open
   * lands inside this range (gap filter). `entry` is then the reference price (signal-day close).
   */
  openRange?: { low: number; high: number };
  /** Per-share risk to size with: the worst allowed fill (top of openRange) minus the stop. */
  sizingRisk?: number;
  /** R:R if filled at the top of the open range (the worst allowed fill). */
  rrWorst?: number | null;
  /** Hard time stop: exit at the close of this trading day if neither stop nor target hit. */
  timeExit?: { days: number; date: string };
  /** Stop-limit entries: `entry` is the buy-stop trigger and this is the highest acceptable fill. */
  limit?: number;
  /** Percent of the position sold at `target` (T1); the rest is managed by `trail`. */
  scaleOutPct?: number;
  /** Runner exit: a daily close below this moving average (current value shown). */
  trail?: { label: string; value: number };
};

/** One-line description of each strategy's level rules, shown under the playbook. */
export const LEVEL_RULES: Record<string, string> = {
  vwap: "Fade toward today's VWAP: enter 0.75 ATR beyond VWAP (below it to buy, above it to short), target VWAP, stop 0.5 ATR past the entry. Recheck against the live VWAP tomorrow.",
  orb: "Buy a break of today's high (short a break of today's low if it closed weak). Stop 0.5 ATR back, target 2R. Tighten to the actual opening range once the session starts.",
  gap_go: "Buy a break of today's high. Stop at the higher of today's midpoint or entry − 1 ATR. Target 2R.",
  squeeze: "Buy a break of today's (narrow) high, stop just under today's low, target 2R.",
  momentum: "Buy a break of the 52-week high (or today's high if higher). Stop 1.5 ATR below, target 2R.",
  pullback:
    "Buy-stop 1¢ above the confirmation candle's high, limit 0.25 ATR above that (no fill higher). " +
    "Stop 0.5 ATR below the 5-day swing low. T1 = the prior 20-day swing high: sell 50%, then move the stop to breakeven. " +
    "T2 = trail the other 50% and exit on a daily close below the 20 EMA. Setups under 2:1 reward-to-risk to T1 are hidden. " +
    "Size uses the limit price, the worst fill.",
  oversold:
    "Market-on-open buy on the next session (T+1), only if it opens between close − 1 ATR and close + 0.5 ATR; skip the trade otherwise. " +
    "Stop at close − 1.5 ATR (a fixed price). Target the 10-day average, or entry + 1.5 ATR if the 10-day is below the entry. " +
    "Time exit at the close of the 5th trading day. Size assumes the worst allowed fill (top of the range), so a gap up can't enlarge the risk.",
};

const round = (x: number) => Math.round(x * 100) / 100;
const TICK = 0.01;
/** Setups more volatile than this (ATR as a share of price) get no mechanical plan. */
export const MAX_ATR_PCT = 0.12;

/** Add `n` weekdays to an ISO date (market holidays are not skipped). */
export function addTradingDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function plan(side: "Long" | "Short", entry: number, stop: number, target: number, how: string): Levels | null {
  const risk = side === "Long" ? entry - stop : stop - entry;
  const reward = side === "Long" ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0) || !Number.isFinite(risk)) return null;
  return { side, entry: round(entry), stop: round(stop), target: round(target), rr: Math.round((reward / risk) * 10) / 10, how };
}

/** 2R target from entry and stop. */
const twoR = (side: "Long" | "Short", entry: number, stop: number) =>
  side === "Long" ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry);

export function levelsFor(strategy: string, r: ScreenerRow): Levels | null {
  const { close, atr14: atr, day_high: hi, day_low: lo } = r;
  if (close == null || atr == null || !(atr > 0)) return null;
  // Too volatile for mechanical levels to mean anything (e.g. pump-and-dump microcaps).
  if (atr / close > MAX_ATR_PCT) return null;

  switch (strategy) {
    case "vwap": {
      if (r.vwap == null) return null;
      // Closed above VWAP → look to short a push higher; below → buy a flush lower.
      if (close >= r.vwap) {
        const entry = r.vwap + 0.75 * atr;
        return plan("Short", entry, entry + 0.5 * atr, r.vwap, "Sell short 0.75 ATR above VWAP");
      }
      const entry = r.vwap - 0.75 * atr;
      return plan("Long", entry, entry - 0.5 * atr, r.vwap, "Buy 0.75 ATR below VWAP");
    }
    case "orb": {
      if (hi == null || lo == null) return null;
      const weak = (r.range_pos ?? 50) < 30;
      if (weak) {
        const entry = lo - TICK;
        const stop = entry + 0.5 * atr;
        return plan("Short", entry, stop, twoR("Short", entry, stop), "Sell-stop below today's low");
      }
      const entry = hi + TICK;
      const stop = entry - 0.5 * atr;
      return plan("Long", entry, stop, twoR("Long", entry, stop), "Buy-stop above today's high");
    }
    case "gap_go": {
      if (hi == null || lo == null) return null;
      const entry = hi + TICK;
      const stop = Math.max((hi + lo) / 2, entry - atr);
      return plan("Long", entry, stop, twoR("Long", entry, stop), "Buy-stop above today's high");
    }
    case "squeeze": {
      if (hi == null || lo == null) return null;
      const entry = hi + TICK;
      const stop = lo - TICK;
      return plan("Long", entry, stop, twoR("Long", entry, stop), "Buy-stop above today's narrow high");
    }
    case "momentum": {
      const base = Math.max(hi ?? close, r.high_52w ?? close);
      const entry = base + TICK;
      const stop = entry - 1.5 * atr;
      return plan("Long", entry, stop, twoR("Long", entry, stop), "Buy-stop above the 52-week high");
    }
    case "pullback": {
      if (hi == null || r.swing_low5 == null || r.swing_high20 == null || r.ema20 == null) return null;
      const entry = hi + TICK; // buy-stop above the confirmation candle
      const limit = entry + 0.25 * atr; // stop-limit cap: no fill above this
      const stop = r.swing_low5 - 0.5 * atr; // below the pullback swing low
      const t1 = r.swing_high20; // prior swing high
      const base = plan("Long", entry, stop, t1, "");
      if (!base) return null; // T1 not above the entry → no room to the prior high
      const worstReward = t1 - limit;
      const worstRisk = limit - stop;
      return {
        ...base,
        how: `Buy-stop $${entry.toFixed(2)}, limit $${limit.toFixed(2)} next session; cancel if not triggered`,
        limit: round(limit),
        sizingRisk: round(worstRisk),
        rrWorst: worstReward > 0 ? Math.round((worstReward / worstRisk) * 10) / 10 : null,
        scaleOutPct: 50,
        trail: { label: "EMA 20", value: round(r.ema20) },
      };
    }
    case "oversold": {
      // Signal is known only after the close, so execution is the next open (T+1), not today's close.
      const ref = close;
      const stop = ref - 1.5 * atr; // fixed price, set from the signal day
      const openRange = { low: ref - 1.0 * atr, high: ref + 0.5 * atr };
      const target = r.sma10 != null && r.sma10 > ref ? r.sma10 : ref + 1.5 * atr;
      const base = plan("Long", ref, stop, target, "");
      if (!base) return null;
      const worstRisk = openRange.high - stop; // 2.0 ATR
      const worstReward = target - openRange.high;
      return {
        ...base,
        how: `Market-on-open T+1 if it opens $${openRange.low.toFixed(2)}–$${openRange.high.toFixed(2)}; skip otherwise`,
        openRange: { low: round(openRange.low), high: round(openRange.high) },
        sizingRisk: round(worstRisk),
        rrWorst: worstReward > 0 ? Math.round((worstReward / worstRisk) * 10) / 10 : null,
        timeExit: { days: 5, date: addTradingDays(r.as_of, 5) },
      };
    }
    default:
      return null;
  }
}
