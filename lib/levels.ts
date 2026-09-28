// Mechanical entry / stop / target levels for each strategy, from end-of-day data.
// These are rule-based trade plans for the next session, not predictions: every level
// comes from today's high/low/close, ATR(14), VWAP or moving averages as described per rule.
import type { ScreenerRow } from "./screen.ts";

export type Levels = {
  side: "Long" | "Short" | "Sell put";
  /** Price that triggers the trade (a buy/sell-stop above/below, or a limit for reversion). */
  entry: number;
  /** Where the idea is wrong. For the wheel this is the breakeven if assigned. */
  stop: number;
  /** Profit-taking level. For the wheel this is the buy-back price for the put. */
  target: number;
  /** Reward ÷ risk (null for the wheel, where it isn't meaningful). */
  rr: number | null;
  /** How the entry is triggered, in a few words. */
  how: string;
};

/** One-line description of each strategy's level rules, shown under the playbook. */
export const LEVEL_RULES: Record<string, string> = {
  wheel: "Sell the listed put for the mid price. Take profit by buying it back at 50% of the credit. The stop column shows your breakeven if assigned (strike − credit).",
  vwap: "Fade toward today's VWAP: enter 0.75 ATR beyond VWAP (below it to buy, above it to short), target VWAP, stop 0.5 ATR past the entry. Recheck against the live VWAP tomorrow.",
  orb: "Buy a break of today's high (short a break of today's low if it closed weak). Stop 0.5 ATR back, target 2R. Tighten to the actual opening range once the session starts.",
  gap_go: "Buy a break of today's high. Stop at the higher of today's midpoint or entry − 1 ATR. Target 2R.",
  squeeze: "Buy a break of today's (narrow) high, stop just under today's low, target 2R.",
  momentum: "Buy a break of the 52-week high (or today's high if higher). Stop 1.5 ATR below, target 2R.",
  pullback: "Buy a break of today's high to confirm the bounce. Stop 0.25 ATR under today's low, target 2R.",
  oversold: "Buy near today's close. Stop 1.5 ATR below. Target the 20-day average, or 1 ATR if that's not above the entry.",
};

const round = (x: number) => Math.round(x * 100) / 100;
const TICK = 0.01;
const MAX_RISK_PCT = 0.2;

function plan(side: "Long" | "Short", entry: number, stop: number, target: number, how: string): Levels | null {
  const risk = side === "Long" ? entry - stop : stop - entry;
  const reward = side === "Long" ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0) || !Number.isFinite(risk)) return null;
  // A stop more than 20% away means the stock is too wild for mechanical levels to mean anything.
  if (risk / entry > MAX_RISK_PCT) return null;
  return { side, entry: round(entry), stop: round(stop), target: round(target), rr: Math.round((reward / risk) * 10) / 10, how };
}

/** 2R target from entry and stop. */
const twoR = (side: "Long" | "Short", entry: number, stop: number) =>
  side === "Long" ? entry + 2 * (entry - stop) : entry - 2 * (stop - entry);

export function levelsFor(strategy: string, r: ScreenerRow): Levels | null {
  const { close, atr14: atr, day_high: hi, day_low: lo } = r;
  if (strategy === "wheel") {
    if (r.put_strike == null || r.put_mid == null) return null;
    return {
      side: "Sell put",
      entry: round(r.put_mid),
      stop: round(r.put_strike - r.put_mid),
      target: round(r.put_mid * 0.5),
      rr: null,
      how: `Sell ${r.put_strike}P ${r.put_expiration ?? ""} for ~$${r.put_mid.toFixed(2)}`,
    };
  }
  if (close == null || atr == null || !(atr > 0)) return null;

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
      if (hi == null || lo == null) return null;
      const entry = hi + TICK;
      const stop = lo - 0.25 * atr;
      return plan("Long", entry, stop, twoR("Long", entry, stop), "Buy-stop above today's high");
    }
    case "oversold": {
      const entry = close;
      const stop = entry - 1.5 * atr;
      const target = r.sma20 != null && r.sma20 > entry ? r.sma20 : entry + atr;
      return plan("Long", entry, stop, target, "Buy near the close");
    }
    default:
      return null;
  }
}
