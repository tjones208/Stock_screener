// Regime filter (spec section 5): SPY month-end close vs the mean of its last 10 month-end closes.
import { isMonthEnd, type Calendar } from "./calendar.ts";

export type Regime = {
  riskOn: boolean | null;
  /** State at the prior month-end (null = unknown → plain close ≥ SMA rule). */
  prior?: boolean | null;
  band?: number;
  monthEnd: string | null;
  close: number | null;
  sma: number | null;
  months: { month: string; d: string; close: number }[];
  reason?: string;
};

/**
 * Month-end closes up to signal date t. A month counts once it is complete: its last trading day is
 * on or before t (t itself counts when t is a month end).
 */
export function monthEndCloses(bars: { d: string; c: number }[], t: string, cal: Calendar) {
  const out: { month: string; d: string; close: number }[] = [];
  const sorted = [...bars].filter((b) => b.d <= t).sort((a, b) => a.d.localeCompare(b.d));
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const next = sorted[i + 1];
    const last = next ? next.d.slice(0, 7) !== b.d.slice(0, 7) : isMonthEnd(cal, b.d);
    if (last) out.push({ month: b.d.slice(0, 7), d: b.d, close: b.c });
  }
  return out;
}

/**
 * Regime with a buffer: from risk-on, go risk-off only below SMA × (1 − band); from risk-off, go
 * risk-on at SMA or above; unknown prior state → close ≥ SMA.
 */
export function regimeState(close: number, sma: number, prior: boolean | null | undefined, band: number): boolean {
  return prior === true ? close >= sma * (1 - band) : close >= sma;
}

export function regimeAt(bars: { d: string; c: number }[], t: string, cal: Calendar, months = 10, band = 0, prior: boolean | null = null): Regime {
  const all = monthEndCloses(bars, t, cal);
  const lastN = all.slice(-months);
  if (lastN.length < months) {
    return { riskOn: null, monthEnd: lastN.at(-1)?.d ?? null, close: lastN.at(-1)?.close ?? null, sma: null, months: lastN,
      reason: `Only ${lastN.length} month-end closes available; ${months} needed.` };
  }
  const sma = lastN.reduce((s, m) => s + m.close, 0) / months;
  const cur = lastN[lastN.length - 1];
  return { riskOn: regimeState(cur.close, sma, prior, band), prior, band, monthEnd: cur.d, close: cur.close, sma, months: lastN };
}
