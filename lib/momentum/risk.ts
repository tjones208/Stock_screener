// Volatility brake and tax rules (pure, tested).
import type { MomConfig } from "./config.ts";

/** Annualized realized volatility of the last `days` daily log returns (closes oldest first). */
export function realizedVol(closes: number[], days: number): number | null {
  const c = closes.slice(-(days + 1));
  if (c.length < days + 1) return null;
  const r = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}

/** m = clamp(vol_target / SPY realized vol, vol_scale_floor, 1); 1 when the brake is off or vol is unknown. */
export function volScale(spyCloses: number[], cfg: Pick<MomConfig, "vol_scale" | "vol_target" | "vol_lookback_days" | "vol_scale_floor">) {
  const vol = realizedVol(spyCloses, cfg.vol_lookback_days);
  if (!cfg.vol_scale || vol == null || !(vol > 0)) return { m: 1, vol };
  return { m: Math.min(1, Math.max(cfg.vol_scale_floor, cfg.vol_target / vol)), vol };
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export type ClosedLot = { ticker: string; exit_date: string; pnl: number | null };

/** Tickers sold at a loss within the last `days` calendar days of t (gain exits never block). */
export function washBlocked(closed: ClosedLot[], t: string, days: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of closed) {
    if (l.pnl == null || l.pnl >= 0 || l.exit_date > t || dayDiff(l.exit_date, t) > days) continue;
    const prev = out.get(l.ticker);
    if (!prev || l.exit_date > prev) out.set(l.ticker, l.exit_date);
  }
  return out;
}

/** A buy of `ticker` on `buyDay` is a wash sale when that ticker was sold at a loss within 30 days before. */
export const isWashBuy = (closed: ClosedLot[], ticker: string, buyDay: string) =>
  closed.some((l) => l.ticker === ticker && l.pnl != null && l.pnl < 0 && l.exit_date <= buyDay && dayDiff(l.exit_date, buyDay) <= 30);
