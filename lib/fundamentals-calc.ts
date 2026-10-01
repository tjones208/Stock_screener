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

/** A non-OK Massive response; `status` lets callers tell "ticker not found" from outages. */
export class MassiveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "MassiveError";
  }
}

/** 404 / NOT_FOUND ("Ticker not found."): the ticker no longer exists at Massive. */
export const isNotFound = (e: unknown) =>
  (e instanceof MassiveError && e.status === 404) || /→ 404\b|NOT_FOUND|Ticker not found/i.test(String(e));

export type FundDeps<D, I, B> = { details: (t: string) => Promise<D | null>; income: (t: string) => Promise<I[]>; balance: (t: string) => Promise<B | null> };
export type FundResult<D, I, B> =
  | { kind: "not_found"; error: string }
  | { kind: "ok"; details: D | null; inc: I[]; bs: B | null; errors: { step: string; error: string }[] };

/**
 * One ticker's Massive calls. A 404 on ticker details means the ticker is gone: stop there (no
 * statement calls) so the caller can mark it inactive. Statement failures are collected, not thrown.
 */
export async function fetchFundamentals<D, I, B>(ticker: string, deps: FundDeps<D, I, B>): Promise<FundResult<D, I, B>> {
  const errors: { step: string; error: string }[] = [];
  let details: D | null = null;
  try {
    details = await deps.details(ticker);
  } catch (e) {
    if (isNotFound(e)) return { kind: "not_found", error: String(e).slice(0, 300) };
    errors.push({ step: "details", error: String(e).slice(0, 300) });
  }
  let inc: I[] = [];
  let bs: B | null = null;
  try {
    inc = await deps.income(ticker);
    bs = await deps.balance(ticker);
  } catch (e) {
    errors.push({ step: "financials", error: String(e).slice(0, 300) });
  }
  return { kind: "ok", details, inc, bs, errors };
}

/** Run every queued ticker; one ticker's failure is recorded and the queue continues. */
export async function runQueue(tickers: string[], fn: (t: string) => Promise<"done" | "skipped">) {
  const done: string[] = [], skipped: string[] = [], failed: { ticker: string; error: string }[] = [];
  for (const t of tickers) {
    try {
      ((await fn(t)) === "skipped" ? skipped : done).push(t);
    } catch (e) {
      failed.push({ ticker: t, error: String(e).slice(0, 300) });
    }
  }
  return { done, skipped, failed };
}
