// Ranking and hold/entry rules (pure, tested). ss_mom_build (migration 0023) computes the same thing
// in SQL for the whole universe; these mirror it for the page and the tests.
import type { MomConfig } from "./config.ts";

/** Hold cutoff: CompRank ≤ max(hold_comprank_mult × N, ceil(hold_rank_pct × universe)). */
export const holdCutoff = (cfg: Pick<MomConfig, "hold_comprank_mult" | "hold_rank_pct">, N: number, universe: number) =>
  Math.max(cfg.hold_comprank_mult * N, Math.ceil(cfg.hold_rank_pct * universe));

/** percent_rank × 100: share of the other values strictly below x. */
const pctRank = (xs: (number | null)[], x: number | null) => {
  if (xs.length < 2) return 0;
  if (x == null) return 0;
  // SQL sorts nulls first, so they count as below every real value.
  return (100 * xs.filter((v) => v == null || v < x).length) / (xs.length - 1);
};

export type RankInput = { ticker: string; mom: number; h52: number; sigma252: number | null };

/**
 * Composite scores and CompRank. classic = 0.5 × mom pct + 0.5 × H52 pct; risk_adj = 0.75 ×
 * pct(mom / σ252) + 0.25 × H52 pct (no σ252 → bottom of that percentile). Ties go to higher mom.
 */
export function rankUniverse(rows: RankInput[], method: MomConfig["rank_method"]) {
  const mom = rows.map((r) => r.mom), h52 = rows.map((r) => r.h52);
  const risk = rows.map((r) => (r.sigma252 && r.sigma252 > 0 ? r.mom / r.sigma252 : null));
  const scored = rows.map((r, i) => {
    const mom_pct = pctRank(mom, r.mom), h52_pct = pctRank(h52, r.h52), risk_pct = pctRank(risk, risk[i]);
    const classic = 0.5 * mom_pct + 0.5 * h52_pct, risk_adj = 0.75 * risk_pct + 0.25 * h52_pct;
    return { ...r, mom_pct, h52_pct, classic, risk_adj, composite: method === "classic" ? classic : risk_adj };
  });
  return [...scored].sort((a, b) => b.composite - a.composite || b.mom - a.mom).map((r, i) => ({ ...r, comp_rank: i + 1 }));
}

export type RuleRow = {
  mom: number; mom_pct: number; h52: number; days_since_high: number; comp_rank: number; close: number;
  median_dv60: number | null; buyoutReview: boolean; inUniverse: boolean;
};

/** Entry test, with absolute momentum and the buyout-review block. */
export function entryOk(r: RuleRow, cfg: MomConfig) {
  return r.inUniverse && !r.buyoutReview && r.mom > cfg.abs_mom_min && r.mom_pct >= cfg.entry_mom_pct && r.h52 >= cfg.entry_h52
    && r.days_since_high <= cfg.entry_max_days_since_high;
}

/**
 * Hold test for a held name. Universe membership, data flags and a missing market cap don't matter;
 * only a buyout review, price, liquidity and the signal tests on the available bars do.
 */
export function holdVerdict(r: RuleRow, cfg: MomConfig, cutoff: number): { ok: boolean; reason: string | null } {
  const fail = (reason: string) => ({ ok: false, reason });
  if (r.buyoutReview) return fail("Possible pending buyout");
  if (r.close < cfg.min_price) return fail(`Close below $${cfg.min_price}`);
  if (r.median_dv60 == null || r.median_dv60 < 0.5 * cfg.min_median_dollar_vol_60d) return fail("Median 60-day dollar volume under half the minimum");
  if (r.mom_pct < cfg.hold_mom_pct) return fail("Momentum percentile below the hold minimum");
  if (r.h52 < cfg.hold_h52) return fail("H52 below the hold minimum");
  if (r.comp_rank > cutoff) return fail(`CompRank ${r.comp_rank} is past the hold cutoff ${cutoff}`);
  return { ok: true, reason: null };
}
