// Data-quality gate and earnings check for new buys (pure, tested).
// When the gate fails, the build still runs stops, exits and ticket roll-forward, but creates no
// new buy tickets (no new plan, no alternate promotions, no top-ups).
import type { MomConfig } from "./config.ts";

export type RunQuality = {
  /** Stocks left after the last universe filter. */
  universe: number;
  /** Liquid names (≥ min price, ≥ half the dollar-volume floor) with no market cap loaded. */
  no_mcap: number;
  /** Days of the last 90 calendar days covered by the news sweep. */
  news_days: number | null;
};

export type Gate = { ok: boolean; reasons: string[]; comparedTo: string | null };

type GateCfg = Pick<MomConfig, "gate_max_universe_change_pct" | "gate_max_missing_market_caps" | "gate_min_news_days">;

/** Did this run's market caps load well enough for its universe size to mean anything? */
export const passedMcapCheck = (q: Pick<RunQuality, "no_mcap"> | null | undefined, cfg: GateCfg) =>
  q != null && q.no_mcap <= cfg.gate_max_missing_market_caps;

/**
 * The gate. The universe-size comparison only uses a previous run that also passed the market-cap
 * check (and only when this run passes it), so a one-time jump while market caps backfill
 * (e.g. 376 → 1,551 on 9/28 → 9/29) never blocks a later run.
 */
export function dataGate(cur: RunQuality, prev: { signal_date: string; quality: RunQuality } | null, cfg: GateCfg): Gate {
  const reasons: string[] = [];
  if (cur.no_mcap > cfg.gate_max_missing_market_caps) {
    reasons.push(`${cur.no_mcap} liquid stocks have no market cap loaded (limit ${cfg.gate_max_missing_market_caps}).`);
  }
  if (cur.news_days == null || cur.news_days < cfg.gate_min_news_days) {
    reasons.push(`The news sweep covers ${cur.news_days ?? 0} of the last 90 days (needs ${cfg.gate_min_news_days}), so buyout screening is incomplete.`);
  }
  let comparedTo: string | null = null;
  if (prev && passedMcapCheck(prev.quality, cfg) && passedMcapCheck(cur, cfg) && prev.quality.universe > 0) {
    comparedTo = prev.signal_date;
    const change = cur.universe / prev.quality.universe - 1;
    if (Math.abs(change) > cfg.gate_max_universe_change_pct) {
      reasons.push(`The universe changed ${(change * 100).toFixed(0)}% since ${prev.signal_date} (${prev.quality.universe} → ${cur.universe}; limit ±${Math.round(cfg.gate_max_universe_change_pct * 100)}%).`);
    }
  }
  return { ok: reasons.length === 0, reasons, comparedTo };
}

/** Earnings data is usable only when the last sync didn't fail and future report dates exist. */
export function earningsChecked(futureRows: number, syncError: string | null | undefined) {
  if (syncError) return { ok: false, reason: `The earnings sync failed (${syncError.slice(0, 120)}).` };
  if (futureRows <= 0) return { ok: false, reason: "The earnings calendar has no upcoming report dates." };
  return { ok: true, reason: null };
}
