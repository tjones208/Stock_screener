// Screener filter definitions and evaluation. Pure — shared by the UI, saved screens and alerts.

export type ScreenerRow = {
  ticker: string;
  name: string | null;
  type: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  market_cap: number | null;
  in_sp500: boolean;
  has_options: boolean | null;
  as_of: string;
  close: number | null;
  change_pct: number | null;
  gap_pct: number | null;
  volume: number | null;
  avg_vol20: number | null;
  vol_ratio: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  sma50_prev: number | null;
  sma200_prev: number | null;
  ema9: number | null;
  ema21: number | null;
  rsi14: number | null;
  atr14: number | null;
  hv30: number | null;
  high_52w: number | null;
  low_52w: number | null;
  pct_from_high: number | null;
  pct_from_low: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  eps_ttm: number | null;
  revenue_ttm: number | null;
  revenue_growth_yoy: number | null;
  gross_margin: number | null;
  operating_margin: number | null;
  net_margin: number | null;
  roe: number | null;
  debt_to_equity: number | null;
  current_ratio: number | null;
  free_cash_flow_ttm: number | null;
  dividend_yield: number | null;
  next_earnings_date: string | null;
  put_contract: string | null;
  put_expiration: string | null;
  put_dte: number | null;
  put_strike: number | null;
  put_mid: number | null;
  put_iv: number | null;
  put_delta: number | null;
  put_oi: number | null;
  put_spread_pct: number | null;
  put_annual_yield: number | null;
  wheel_score: number | null;
  vwap: number | null;
  range_pos: number | null;
  change_5d: number | null;
  change_20d: number | null;
  nr7: boolean | null;
  inside_day: boolean | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  sma10: number | null;
  prev_open: number | null;
  prev_close: number | null;
  ema20: number | null;
  ema20_5d: number | null;
  swing_low5: number | null;
  swing_high20: number | null;
  resistance60: number | null;
  rsi_min5: number | null;
};

export const GROUPS = ["Price & volume", "Day trading", "Technical", "Fundamental", "Wheel"] as const;

export type NumericField = {
  /** A ScreenerRow column, or a derived key computed by `compute`. Used as the URL filter prefix. */
  key: string;
  label: string;
  group: (typeof GROUPS)[number];
  unit?: string;
  /** Derived value (not stored in the database). */
  compute?: (r: ScreenerRow) => number | null;
  /** Multiply the stored value by this for display/filter input (e.g. 100 for fractions shown as %). */
  scale?: number;
  /** Absolute value before comparing (delta). */
  abs?: boolean;
};

export const NUMERIC_FIELDS: NumericField[] = [
  { key: "close", label: "Price", group: "Price & volume", unit: "$" },
  { key: "change_pct", label: "Change today", group: "Price & volume", unit: "%" },
  { key: "gap_pct", label: "Gap at open", group: "Price & volume", unit: "%" },
  { key: "avg_vol20", label: "Avg volume (20d)", group: "Price & volume" },
  { key: "vol_ratio", label: "Volume vs avg", group: "Price & volume", unit: "×" },
  { key: "dollar_vol", label: "Avg $ volume (20d)", group: "Price & volume", unit: "$",
    compute: (r) => (r.avg_vol20 != null && r.close != null ? r.avg_vol20 * r.close : null) },
  { key: "market_cap", label: "Market cap", group: "Price & volume", unit: "$" },
  { key: "atr_pct", label: "ATR % of price", group: "Day trading", unit: "%",
    compute: (r) => (r.atr14 != null && r.close ? (r.atr14 / r.close) * 100 : null) },
  { key: "gap_abs", label: "Gap size (up or down)", group: "Day trading", unit: "%",
    compute: (r) => (r.gap_pct == null ? null : Math.abs(r.gap_pct)) },
  { key: "pct_from_vwap", label: "Close vs VWAP", group: "Day trading", unit: "%",
    compute: (r) => (r.close != null && r.vwap ? ((r.close - r.vwap) / r.vwap) * 100 : null) },
  { key: "range_pos", label: "Close in day's range (0 low–100 high)", group: "Day trading", unit: "%" },
  { key: "rsi14", label: "RSI (14)", group: "Technical" },
  { key: "rsi_min5", label: "Lowest RSI (last 5 days)", group: "Technical" },
  { key: "hv30", label: "Hist. volatility (30d)", group: "Technical", unit: "%", scale: 100 },
  { key: "atr14", label: "ATR (14)", group: "Technical", unit: "$" },
  { key: "change_5d", label: "Change 5 days", group: "Technical", unit: "%" },
  { key: "change_20d", label: "Change 20 days", group: "Technical", unit: "%" },
  { key: "pct_from_ema20", label: "Close vs EMA 20", group: "Technical", unit: "%",
    compute: (r) => (r.close != null && r.ema20 ? ((r.close - r.ema20) / r.ema20) * 100 : null) },
  { key: "pct_from_sma10", label: "Close vs SMA 10", group: "Technical", unit: "%",
    compute: (r) => (r.close != null && r.sma10 ? ((r.close - r.sma10) / r.sma10) * 100 : null) },
  { key: "pct_from_sma20", label: "Close vs SMA 20", group: "Technical", unit: "%",
    compute: (r) => (r.close != null && r.sma20 ? ((r.close - r.sma20) / r.sma20) * 100 : null) },
  { key: "pct_from_sma50", label: "Close vs SMA 50", group: "Technical", unit: "%",
    compute: (r) => (r.close != null && r.sma50 ? ((r.close - r.sma50) / r.sma50) * 100 : null) },
  { key: "pct_from_high", label: "From 52w high", group: "Technical", unit: "%" },
  { key: "pct_from_low", label: "From 52w low", group: "Technical", unit: "%" },
  { key: "pe", label: "P/E", group: "Fundamental" },
  { key: "ps", label: "P/S", group: "Fundamental" },
  { key: "pb", label: "P/B", group: "Fundamental" },
  { key: "eps_ttm", label: "EPS (TTM)", group: "Fundamental", unit: "$" },
  { key: "revenue_growth_yoy", label: "Revenue growth YoY", group: "Fundamental", unit: "%" },
  { key: "gross_margin", label: "Gross margin", group: "Fundamental", unit: "%" },
  { key: "operating_margin", label: "Operating margin", group: "Fundamental", unit: "%" },
  { key: "net_margin", label: "Net margin", group: "Fundamental", unit: "%" },
  { key: "roe", label: "ROE", group: "Fundamental", unit: "%" },
  { key: "debt_to_equity", label: "Debt / equity", group: "Fundamental" },
  { key: "current_ratio", label: "Current ratio", group: "Fundamental" },
  { key: "dividend_yield", label: "Dividend yield", group: "Fundamental", unit: "%" },
  { key: "put_annual_yield", label: "Put annual yield", group: "Wheel", unit: "%", scale: 100 },
  { key: "put_iv", label: "Put IV", group: "Wheel", unit: "%", scale: 100 },
  { key: "put_delta", label: "Put delta (abs)", group: "Wheel", abs: true },
  { key: "put_oi", label: "Put open interest", group: "Wheel" },
  { key: "put_spread_pct", label: "Put bid/ask spread", group: "Wheel", unit: "%", scale: 100 },
  { key: "put_dte", label: "Put days to expiry", group: "Wheel" },
  { key: "wheel_score", label: "Wheel score", group: "Wheel" },
];

export const BOOL_FILTERS = {
  above_sma20: { label: "Price above SMA 20", test: (r: ScreenerRow) => gt(r.close, r.sma20) },
  above_sma50: { label: "Price above SMA 50", test: (r: ScreenerRow) => gt(r.close, r.sma50) },
  above_sma200: { label: "Price above SMA 200", test: (r: ScreenerRow) => gt(r.close, r.sma200) },
  below_sma200: { label: "Price below SMA 200", test: (r: ScreenerRow) => gt(r.sma200, r.close) },
  sma50_above_sma200: { label: "SMA 50 above SMA 200", test: (r: ScreenerRow) => gt(r.sma50, r.sma200) },
  ema9_above_ema21: { label: "EMA 9 above EMA 21", test: (r: ScreenerRow) => gt(r.ema9, r.ema21) },
  above_vwap: { label: "Closed above VWAP", test: (r: ScreenerRow) => gt(r.close, r.vwap) },
  below_vwap: { label: "Closed below VWAP", test: (r: ScreenerRow) => gt(r.vwap, r.close) },
  nr7: { label: "NR7 (narrowest range in 7 days)", test: (r: ScreenerRow) => r.nr7 === true },
  inside_day: { label: "Inside day", test: (r: ScreenerRow) => r.inside_day === true },
  golden_cross: { label: "Golden cross today", test: goldenCross },
  death_cross: { label: "Death cross today", test: deathCross },
  near_52w_high: { label: "Within 3% of 52w high", test: (r: ScreenerRow) => (r.pct_from_high ?? -99) >= -3 },
  near_52w_low: { label: "Within 3% of 52w low", test: (r: ScreenerRow) => (r.pct_from_low ?? 99) <= 3 },
  has_put: { label: "Has a wheel-eligible put", test: (r: ScreenerRow) => r.put_contract != null },
  sp500: { label: "S&P 500 only", test: (r: ScreenerRow) => r.in_sp500 },
  green_close: { label: "Green close (close > open)", test: (r: ScreenerRow) => gt(r.close, r.day_open) },
  ema20_above_sma50: { label: "EMA 20 above SMA 50", test: (r: ScreenerRow) => gt(r.ema20, r.sma50) },
  ema20_rising: { label: "EMA 20 rising (vs 5 days ago)", test: (r: ScreenerRow) => gt(r.ema20, r.ema20_5d) },
  exclude_etfs: { label: "Exclude ETFs (stocks and ADRs only)", test: (r: ScreenerRow) => r.type !== "ETF" },
  pullback_support: { label: "Pullback tested support in the last 5 days (EMA 20, SMA 50 or breakout level)", test: (r: ScreenerRow) => supportTest(r) != null },
  pullback_confirm: { label: "Pullback confirmation (hammer, engulfing or EMA 20 reclaim)", test: (r: ScreenerRow) => pullbackConfirmation(r) != null },
  bullish_reversal: { label: "Bullish reversal candle (green, hammer or engulfing)", test: (r: ScreenerRow) => reversalPattern(r) != null },
  no_earnings_5d: {
    label: "No earnings in next 5 trading days",
    test: (r: ScreenerRow) => !earningsWithin(r, 5),
  },
  no_earnings_30d: {
    label: "No earnings in next 30 days",
    test: (r: ScreenerRow) => !r.next_earnings_date || daysUntil(r.next_earnings_date) > 30 || daysUntil(r.next_earnings_date) < 0,
  },
} satisfies Record<string, { label: string; test: (r: ScreenerRow) => boolean }>;

export type BoolKey = keyof typeof BOOL_FILTERS;

/** Flat filter map, identical to the screener URL query: close_max=50&rsi14_min=30&above_sma200=1&sector=Technology */
export type Filters = Record<string, string>;

export const DEFAULT_FILTERS: Filters = { close_min: "5", close_max: "50", avg_vol20_min: "500000" };

function gt(a: number | null, b: number | null) {
  return a != null && b != null && a > b;
}
export function goldenCross(r: ScreenerRow) {
  return r.sma50 != null && r.sma200 != null && r.sma50_prev != null && r.sma200_prev != null &&
    r.sma50 > r.sma200 && r.sma50_prev <= r.sma200_prev;
}
export function deathCross(r: ScreenerRow) {
  return r.sma50 != null && r.sma200 != null && r.sma50_prev != null && r.sma200_prev != null &&
    r.sma50 < r.sma200 && r.sma50_prev >= r.sma200_prev;
}
function daysUntil(iso: string) {
  return Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
}

/** Weekdays from `fromIso` (exclusive) through `toIso` (inclusive); 0 if it's the same day, negative if past. */
export function tradingDaysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso + "T00:00:00Z"), to = Date.parse(toIso + "T00:00:00Z");
  if (to <= from) return Math.round((to - from) / 86_400_000) === 0 ? 0 : -1;
  let n = 0;
  for (let t = from + 86_400_000; t <= to; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

/**
 * True when an earnings date is known and falls within the next `n` trading days of the
 * signal date. Unknown dates return false — the free data plans carry no earnings calendar,
 * so callers should flag "unknown" rather than treat it as clear (see earningsStatus).
 */
export function earningsWithin(r: ScreenerRow, n: number): boolean {
  if (!r.next_earnings_date) return false;
  const days = tradingDaysBetween(r.as_of, r.next_earnings_date);
  return days >= 0 && days <= n;
}

export function earningsStatus(r: ScreenerRow): "unknown" | "clear" | "soon" {
  if (!r.next_earnings_date) return "unknown";
  return earningsWithin(r, 5) ? "soon" : "clear";
}

/**
 * Bullish confirmation on the signal day, strongest first:
 *  - engulfing: prior day red, today green, opened ≤ prior close and closed ≥ prior open
 *  - hammer:    lower wick ≥ 2× the body, upper wick ≤ the body, close in the top half of the range
 *  - green:     close > open
 */
export function reversalPattern(r: ScreenerRow): "engulfing" | "hammer" | "green" | null {
  if (isEngulfing(r)) return "engulfing";
  if (isHammer(r)) return "hammer";
  if (r.close != null && r.day_open != null && r.close > r.day_open) return "green";
  return null;
}

/** Prior day red, today green, opened at/below the prior close and closed at/above the prior open. */
export function isEngulfing(r: ScreenerRow): boolean {
  const { day_open: o, close: c, prev_open: po, prev_close: pc } = r;
  return o != null && c != null && po != null && pc != null && pc < po && c > o && o <= pc && c >= po;
}

/** Lower wick ≥ 2× the body, upper wick ≤ the body, close in the top half of the day's range. */
export function isHammer(r: ScreenerRow): boolean {
  const { day_open: o, day_high: h, day_low: l, close: c } = r;
  if (o == null || h == null || l == null || c == null) return false;
  const range = h - l;
  const body = Math.abs(c - o);
  return range > 0 && Math.min(o, c) - l >= 2 * body && h - Math.max(o, c) <= body && (c - l) / range >= 0.5;
}

/** Within this many ATRs counts as "testing" a support level. */
export const SUPPORT_TOLERANCE_ATR = 0.25;

/**
 * Which support the pullback tested: the pullback's low (lowest low of the last 5 sessions, so the
 * test can come a day or more before the confirmation candle) reached within 0.25 ATR of the level,
 * and today's close held no more than 0.25 ATR below it. Checked nearest-first: EMA 20, SMA 50, then
 * the prior breakout level (the 21–60-day high, only if the last 20 days actually broke above it).
 */
export function supportTest(r: ScreenerRow): "EMA 20" | "SMA 50" | "breakout level" | null {
  const { close: c, atr14: atr } = r;
  const lo = r.swing_low5 ?? r.day_low;
  if (lo == null || c == null || atr == null || !(atr > 0)) return null;
  const tol = SUPPORT_TOLERANCE_ATR * atr;
  const tests = (level: number | null) => level != null && lo <= level + tol && c >= level - tol;
  if (tests(r.ema20)) return "EMA 20";
  if (tests(r.sma50)) return "SMA 50";
  if (r.resistance60 != null && r.swing_high20 != null && r.swing_high20 > r.resistance60 && tests(r.resistance60)) return "breakout level";
  return null;
}

/**
 * Daily bullish confirmation for a pullback (the 1-hour chart isn't available): a hammer, a bullish
 * engulfing, or a green candle that closed back above the EMA 20 after trading below it — either
 * today's low was at/below it or yesterday closed below it.
 */
export function pullbackConfirmation(r: ScreenerRow): "engulfing" | "hammer" | "EMA 20 reclaim" | null {
  if (isEngulfing(r)) return "engulfing";
  if (isHammer(r)) return "hammer";
  const { day_open: o, day_low: lo, close: c, prev_close: pc, ema20 } = r;
  if (o == null || lo == null || c == null || ema20 == null) return null;
  const wasBelow = lo <= ema20 || (pc != null && pc < ema20);
  if (c > o && c > ema20 && wasBelow) return "EMA 20 reclaim";
  return null;
}

export function displayValue(f: NumericField, r: ScreenerRow): number | null {
  const v = f.compute ? f.compute(r) : ((r[f.key as keyof ScreenerRow] as number | null) ?? null);
  if (v == null) return null;
  const x = f.abs ? Math.abs(v) : v;
  return x * (f.scale ?? 1);
}

export function matches(r: ScreenerRow, filters: Filters): boolean {
  for (const f of NUMERIC_FIELDS) {
    const min = filters[`${f.key}_min`];
    const max = filters[`${f.key}_max`];
    if (!min && !max) continue;
    const v = displayValue(f, r);
    if (v == null) return false;
    if (min && v < Number(min)) return false;
    if (max && v > Number(max)) return false;
  }
  for (const [key, def] of Object.entries(BOOL_FILTERS)) {
    if (filters[key] === "1" && !def.test(r)) return false;
  }
  if (filters.sector && r.sector !== filters.sector) return false;
  if (filters.type && r.type !== filters.type) return false;
  if (filters.q) {
    const q = filters.q.toUpperCase();
    if (!r.ticker.includes(q) && !(r.name ?? "").toUpperCase().includes(q)) return false;
  }
  return true;
}

export function applyFilters(rows: ScreenerRow[], filters: Filters): ScreenerRow[] {
  const out = rows.filter((r) => matches(r, filters));
  const dir = filters.dir === "asc" ? 1 : -1;
  const get = sortGetter(filters.sort || "wheel_score");
  return out.sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return a.ticker.localeCompare(b.ticker);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * dir;
    return ((av as number) - (bv as number)) * dir;
  });
}

const FIELD_BY_KEY = new Map(NUMERIC_FIELDS.map((f) => [f.key, f]));

/** Value used for sorting by `key`: derived fields are computed, stored columns read directly. */
export function sortGetter(key: string): (r: ScreenerRow) => unknown {
  const f = FIELD_BY_KEY.get(key);
  if (f?.compute) return (r) => f.compute!(r);
  return (r) => r[key as keyof ScreenerRow];
}

/** Keep only filter keys we understand (from URL params or saved screens). */
export function cleanFilters(input: Record<string, string | string[] | undefined>): Filters {
  const allowed = new Set<string>(["sector", "type", "q", "sort", "dir", "strategy", "side", ...Object.keys(BOOL_FILTERS)]);
  for (const f of NUMERIC_FIELDS) {
    allowed.add(`${f.key}_min`);
    allowed.add(`${f.key}_max`);
  }
  const out: Filters = {};
  for (const [k, v] of Object.entries(input)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s && allowed.has(k)) out[k] = s;
  }
  return out;
}
