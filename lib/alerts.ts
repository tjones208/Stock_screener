// Alert rule evaluation. Pure — the nightly job feeds it screener rows and saves the hits.
import { applyFilters, deathCross, goldenCross, type Filters, type ScreenerRow } from "./screen.ts";
import { meetsMinRR, STRATEGY_BY_KEY, strategyGate, type MarketRegime } from "./strategies.ts";
import { levelsFor } from "./levels.ts";

export type AlertRule = {
  id: number;
  name: string;
  kind: AlertKind;
  ticker: string | null;
  screen_id: number | null;
  watchlist_id: number | null;
  params: Record<string, number | string>;
  enabled: boolean;
};

export const ALERT_KINDS = {
  price_above: { label: "Price closes above", param: "price" },
  price_below: { label: "Price closes below", param: "price" },
  rsi_below: { label: "RSI(14) below", param: "value" },
  rsi_above: { label: "RSI(14) above", param: "value" },
  golden_cross: { label: "Golden cross (SMA 50 over 200)", param: null },
  death_cross: { label: "Death cross (SMA 50 under 200)", param: null },
  volume_spike: { label: "Volume spike (× 20-day avg)", param: "ratio" },
  new_52w_high: { label: "New 52-week high", param: null },
  new_52w_low: { label: "New 52-week low", param: null },
  gap: { label: "Gap at open ≥ %", param: "pct" },
  wheel_yield: { label: "Put annual yield ≥ %", param: "min_yield" },
  screen_match: { label: "New match for saved screen", param: null },
} as const;

export type AlertKind = keyof typeof ALERT_KINDS;

export type AlertHit = { rule_id: number; ticker: string; message: string; payload: Record<string, unknown> };

const fmt = (n: number | null | undefined, d = 2) => (n == null ? "—" : n.toFixed(d));

function check(rule: AlertRule, r: ScreenerRow): string | null {
  const p = Number(rule.params[ALERT_KINDS[rule.kind].param ?? ""] ?? NaN);
  switch (rule.kind) {
    case "price_above":
      return r.close != null && r.close > p ? `${r.ticker} closed at $${fmt(r.close)} (above $${fmt(p)})` : null;
    case "price_below":
      return r.close != null && r.close < p ? `${r.ticker} closed at $${fmt(r.close)} (below $${fmt(p)})` : null;
    case "rsi_below":
      return r.rsi14 != null && r.rsi14 < p ? `${r.ticker} RSI ${fmt(r.rsi14, 1)} (below ${p})` : null;
    case "rsi_above":
      return r.rsi14 != null && r.rsi14 > p ? `${r.ticker} RSI ${fmt(r.rsi14, 1)} (above ${p})` : null;
    case "golden_cross":
      return goldenCross(r) ? `${r.ticker} golden cross: SMA50 ${fmt(r.sma50)} > SMA200 ${fmt(r.sma200)}` : null;
    case "death_cross":
      return deathCross(r) ? `${r.ticker} death cross: SMA50 ${fmt(r.sma50)} < SMA200 ${fmt(r.sma200)}` : null;
    case "volume_spike":
      return r.vol_ratio != null && r.vol_ratio >= (Number.isNaN(p) ? 2 : p)
        ? `${r.ticker} volume ${fmt(r.vol_ratio, 1)}× its 20-day average` : null;
    case "new_52w_high":
      return r.close != null && r.high_52w != null && r.close >= r.high_52w * 0.995
        ? `${r.ticker} at a 52-week high ($${fmt(r.close)})` : null;
    case "new_52w_low":
      return r.close != null && r.low_52w != null && r.close <= r.low_52w * 1.005
        ? `${r.ticker} at a 52-week low ($${fmt(r.close)})` : null;
    case "gap":
      return r.gap_pct != null && Math.abs(r.gap_pct) >= (Number.isNaN(p) ? 3 : p)
        ? `${r.ticker} gapped ${r.gap_pct > 0 ? "up" : "down"} ${fmt(Math.abs(r.gap_pct), 1)}%` : null;
    case "wheel_yield":
      return r.put_annual_yield != null && r.put_annual_yield * 100 >= p
        ? `${r.ticker} $${fmt(r.put_strike)}P ${r.put_expiration}: ${fmt(r.put_annual_yield * 100, 0)}%/yr, Δ${fmt(Math.abs(r.put_delta ?? 0))}, mid $${fmt(r.put_mid)}`
        : null;
    case "screen_match":
      return `${r.ticker} matches “${rule.name}” ($${fmt(r.close)})`;
  }
}

export function evaluateRules(
  rules: AlertRule[],
  rows: ScreenerRow[],
  ctx: { watchlists: Map<number, Set<string>>; screens: Map<number, Filters>; regime?: MarketRegime },
): AlertHit[] {
  const byTicker = new Map(rows.map((r) => [r.ticker, r]));
  const hits: AlertHit[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let targets: ScreenerRow[];
    if (rule.ticker) {
      const r = byTicker.get(rule.ticker.toUpperCase());
      targets = r ? [r] : [];
    } else if (rule.watchlist_id != null) {
      const set = ctx.watchlists.get(rule.watchlist_id) ?? new Set();
      targets = rows.filter((r) => set.has(r.ticker));
    } else {
      targets = rows;
    }
    if (rule.screen_id != null) {
      const f = ctx.screens.get(rule.screen_id);
      targets = f ? applyScreen(targets, f, ctx.regime ?? null) : [];
    } else if (rule.kind === "screen_match") {
      targets = []; // screen_match needs a screen
    }
    for (const r of targets) {
      const message = check(rule, r);
      if (message) hits.push({ rule_id: rule.id, ticker: r.ticker, message, payload: { close: r.close, as_of: r.as_of } });
    }
  }
  return hits;
}

/**
 * A saved screen as the screener shows it: its filters, plus — when it was saved from a strategy —
 * that strategy's market-regime gate and minimum reward-to-risk. Keeps alerts from firing on setups
 * the screener would hide.
 */
export function applyScreen(rows: ScreenerRow[], f: Filters, regime: MarketRegime): ScreenerRow[] {
  const strategy = f.strategy ? STRATEGY_BY_KEY.get(f.strategy) : undefined;
  if (strategy && !strategyGate(strategy, regime).ok) return [];
  const matched = applyFilters(rows, f);
  if (!strategy?.minRR) return matched;
  return matched.filter((r) => meetsMinRR(strategy, levelsFor(strategy.key, r)));
}
