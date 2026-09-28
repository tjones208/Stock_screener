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
};

export type NumericField = {
  key: keyof ScreenerRow;
  label: string;
  group: "Price & volume" | "Technical" | "Fundamental" | "Wheel";
  unit?: string;
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
  { key: "market_cap", label: "Market cap", group: "Price & volume", unit: "$" },
  { key: "rsi14", label: "RSI (14)", group: "Technical" },
  { key: "hv30", label: "Hist. volatility (30d)", group: "Technical", unit: "%", scale: 100 },
  { key: "atr14", label: "ATR (14)", group: "Technical", unit: "$" },
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
  golden_cross: { label: "Golden cross today", test: goldenCross },
  death_cross: { label: "Death cross today", test: deathCross },
  near_52w_high: { label: "Within 3% of 52w high", test: (r: ScreenerRow) => (r.pct_from_high ?? -99) >= -3 },
  near_52w_low: { label: "Within 3% of 52w low", test: (r: ScreenerRow) => (r.pct_from_low ?? 99) <= 3 },
  has_put: { label: "Has a wheel-eligible put", test: (r: ScreenerRow) => r.put_contract != null },
  sp500: { label: "S&P 500 only", test: (r: ScreenerRow) => r.in_sp500 },
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

export function displayValue(f: NumericField, r: ScreenerRow): number | null {
  const v = r[f.key] as number | null;
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
  const sort = (filters.sort || "wheel_score") as keyof ScreenerRow;
  const dir = filters.dir === "asc" ? 1 : -1;
  return out.sort((a, b) => {
    const av = a[sort], bv = b[sort];
    if (av == null && bv == null) return a.ticker.localeCompare(b.ticker);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string" || typeof bv === "string") return String(av).localeCompare(String(bv)) * dir;
    return ((av as number) - (bv as number)) * dir;
  });
}

/** Keep only filter keys we understand (from URL params or saved screens). */
export function cleanFilters(input: Record<string, string | string[] | undefined>): Filters {
  const allowed = new Set<string>(["sector", "type", "q", "sort", "dir", ...Object.keys(BOOL_FILTERS)]);
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
