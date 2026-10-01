// Pure helpers for the fundamentals job (tested).

/** ss_tickers update from ticker details. market_cap is only written when present, never nulled. */
export function tickerPatch(details: { market_cap?: number | null; weighted_shares_outstanding?: number; share_class_shares_outstanding?: number; sic_code?: string; composite_figi?: string }) {
  const patch: Record<string, unknown> = {
    shares_out: details.weighted_shares_outstanding ?? details.share_class_shares_outstanding ?? null,
    sic_code: details.sic_code ?? null,
    composite_figi: details.composite_figi ?? null,
  };
  if (details.market_cap != null) patch.market_cap = details.market_cap;
  return patch;
}

/** Sum of the last four quarters of one income-statement field (null unless all four exist). */
export function sum4<T>(rows: T[], key: keyof T): number | null {
  const vals = rows.slice(0, 4).map((r) => r[key]);
  return vals.length === 4 && vals.every((v) => typeof v === "number") ? (vals as number[]).reduce((a, b) => a + b, 0) : null;
}
