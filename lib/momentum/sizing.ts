// Position sizing and buy-list selection (spec sections 6 and 7.1–7.5). Pure; used by the page and tests.
import { capitalAndSlots, type MomConfig } from "./config.ts";

/** Stocks with no SIC code share one sector bucket for the sector caps. */
export const UNKNOWN_SECTOR = "unknown";
export const sectorOf = (sic2: string | null | undefined) => sic2 || UNKNOWN_SECTOR;

/**
 * Inverse-volatility weights clamped to [floor/n, cap/n]: clamp, renormalize to sum 1, repeat until
 * stable (at most 20 passes). With n = 1 the single weight is 1.
 */
export function clampWeights(sigmas: number[], cfg: Pick<MomConfig, "weight_floor_mult" | "weight_cap_mult">): number[] {
  const n = sigmas.length;
  if (!n) return [];
  const inv = sigmas.map((s) => 1 / s);
  const total = inv.reduce((a, b) => a + b, 0);
  let w = inv.map((x) => x / total);
  const lo = cfg.weight_floor_mult / n, hi = cfg.weight_cap_mult / n;
  for (let i = 0; i < 20; i++) {
    const c = w.map((x) => Math.min(hi, Math.max(lo, x)));
    const s = c.reduce((a, b) => a + b, 0);
    const next = c.map((x) => x / s);
    const moved = Math.max(...next.map((x, j) => Math.abs(x - w[j])));
    w = next;
    if (moved < 1e-12) break;
  }
  return w;
}

/** Stop distance D = clamp(stop_atr_mult × ATR, stop_min_pct × F, stop_max_pct × F). */
export function stopDistance(atr: number, fill: number, cfg: Pick<MomConfig, "stop_atr_mult" | "stop_min_pct" | "stop_max_pct">): number {
  return Math.min(cfg.stop_max_pct * fill, Math.max(cfg.stop_min_pct * fill, cfg.stop_atr_mult * atr));
}

export const round2 = (x: number) => Math.round(x * 100 + 1e-9) / 100;

/** Chase cap: the most the entry may pay, S × (1 + chase_cap_pct). */
export const entryCap = (S: number, cfg: Pick<MomConfig, "chase_cap_pct">) => round2(S * (1 + cfg.chase_cap_pct));

/** Shares = min(target shares, risk-cap shares); whole shares, or 3 decimals when fractional. */
export function positionShares(T: number, LP: number, D: number, cfg: Pick<MomConfig, "max_risk_pct_of_E" | "E" | "fractional_shares">) {
  const floorTo = (x: number) => (cfg.fractional_shares ? Math.floor(x * 1000 + 1e-9) / 1000 : Math.floor(x + 1e-9));
  const byTarget = floorTo(T / LP);
  const byRisk = floorTo((cfg.max_risk_pct_of_E * cfg.E) / D);
  const shares = Math.min(byTarget, byRisk);
  // Rule 6.7: too few whole shares to be worth it → skip (fractional accounts never skip).
  const tooSmall = !cfg.fractional_shares && shares * LP < 0.5 * T;
  return { shares, byTarget, byRisk, tooSmall };
}

export type Candidate = {
  ticker: string; comp_rank: number; close: number; sigma63: number | null; atr20: number | null;
  sic2: string | null; entry_ok: boolean;
};
export type Held = { ticker: string; sigma63: number | null; sic2: string | null; value: number };

export type PlannedBuy = {
  ticker: string; comp_rank: number; sector: string; sigma63: number; w: number; T: number;
  S: number; cap: number; D: number; byTarget: number; byRisk: number; shares: number; amount: number;
};
export type Skip = { ticker: string; comp_rank: number; reason: string };

export type Plan = {
  I: number; N: number; n: number; openSlots: number;
  buys: PlannedBuy[]; alternates: Candidate[]; skipped: Skip[]; earningsWatch: Candidate[];
  heldWeights: { ticker: string; w: number; T: number }[];
  message?: string;
};

/**
 * Buy list for a signal date. Candidates (entry-eligible, not held, not wash-sale blocked, no earnings
 * in the blackout) fill open slots in CompRank order; a candidate is taken only if the whole portfolio
 * (kept + new) then sizes cleanly: every new name clears rule 6.7 and no sector exceeds its name or
 * dollar cap. Buys are planned at the chase cap (the highest price the ticket may pay); the 9:45
 * ticket recomputes shares at the real limit price.
 */
export function planPortfolio(args: {
  cfg: MomConfig;
  candidates: Candidate[];
  held?: Held[];
  riskOn: boolean | null;
  earnings?: Set<string>;
  washBlocked?: Set<string>;
}): Plan {
  const { cfg } = args;
  const held = args.held ?? [];
  const { I, N } = capitalAndSlots(cfg);
  const empty = { I, N, n: held.length, openSlots: Math.max(0, N - held.length), buys: [], alternates: [], skipped: [], earningsWatch: [], heldWeights: [] };
  if (cfg.B < cfg.min_B_stock_version) {
    return { ...empty, message: `B is below $${cfg.min_B_stock_version.toLocaleString()}: stop the stock version and use a momentum ETF with the same regime filter.` };
  }
  if (args.riskOn !== true) {
    return { ...empty, message: args.riskOn === false ? "Regime is risk-off: no buys or refills." : "Regime unknown: no buys until it can be confirmed." };
  }

  const heldSet = new Set(held.map((h) => h.ticker));
  const skipped: Skip[] = [];
  const earningsWatch: Candidate[] = [];
  const pool: Candidate[] = [];
  for (const c of [...args.candidates].sort((a, b) => a.comp_rank - b.comp_rank)) {
    if (!c.entry_ok || heldSet.has(c.ticker)) continue;
    if (args.washBlocked?.has(c.ticker)) { skipped.push({ ticker: c.ticker, comp_rank: c.comp_rank, reason: "Wash-sale block" }); continue; }
    if (args.earnings?.has(c.ticker)) { earningsWatch.push(c); continue; }
    if (c.sigma63 == null || !(c.sigma63 > 0) || c.atr20 == null) { skipped.push({ ticker: c.ticker, comp_rank: c.comp_rank, reason: "Missing σ63 or ATR20" }); continue; }
    pool.push(c);
  }

  const openSlots = Math.max(0, N - held.length);
  const size = (picks: Candidate[]) => {
    const sig = [...held.map((h) => h.sigma63 ?? NaN), ...picks.map((p) => p.sigma63!)];
    const n = sig.length;
    // A held name without σ63 (dropped out of the universe) gets the median σ so weights still sum to 1.
    const known = sig.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
    const med = known.length ? known[Math.floor(known.length / 2)] : 0.3;
    const w = clampWeights(sig.map((s) => (Number.isFinite(s) ? s : med)), cfg);
    const T = w.map((x) => (x * I * n) / N);
    const buys: PlannedBuy[] = picks.map((p, i) => {
      const j = held.length + i;
      const cap = entryCap(p.close, cfg);
      const D = stopDistance(p.atr20!, cap, cfg);
      const s = positionShares(T[j], cap, D, cfg);
      return {
        ticker: p.ticker, comp_rank: p.comp_rank, sector: sectorOf(p.sic2), sigma63: p.sigma63!, w: w[j], T: T[j],
        S: p.close, cap, D, byTarget: s.byTarget, byRisk: s.byRisk, shares: s.shares, amount: s.shares * cap,
        tooSmall: s.tooSmall,
      } as PlannedBuy & { tooSmall: boolean };
    });
    return { w, T, buys: buys as (PlannedBuy & { tooSmall: boolean })[] };
  };
  const sectorBreach = (buys: PlannedBuy[]): string | null => {
    const names = new Map<string, number>(), dollars = new Map<string, number>();
    for (const h of held) {
      const s = sectorOf(h.sic2);
      names.set(s, (names.get(s) ?? 0) + 1);
      dollars.set(s, (dollars.get(s) ?? 0) + h.value);
    }
    for (const b of buys) {
      names.set(b.sector, (names.get(b.sector) ?? 0) + 1);
      dollars.set(b.sector, (dollars.get(b.sector) ?? 0) + b.amount);
    }
    for (const [s, k] of names) if (k > cfg.sector_max_names) return `Sector ${s}: more than ${cfg.sector_max_names} names`;
    for (const [s, d] of dollars) if (d > cfg.sector_max_pct_of_I * I + 1e-6) return `Sector ${s}: over ${Math.round(cfg.sector_max_pct_of_I * 100)}% of I`;
    return null;
  };

  let picks: Candidate[] = [];
  let rest = pool;
  for (let i = 0; i < pool.length && picks.length < openSlots; i++) {
    const c = pool[i];
    const trial = size([...picks, c]);
    const small = trial.buys.find((b) => b.tooSmall);
    const breach = sectorBreach(trial.buys);
    if (small) skipped.push({ ticker: c.ticker, comp_rank: c.comp_rank, reason: small.ticker === c.ticker ? "Position too small at the chase cap (rule 6.7)" : `Would shrink ${small.ticker} below half its target` });
    else if (breach) skipped.push({ ticker: c.ticker, comp_rank: c.comp_rank, reason: breach });
    else picks = [...picks, c];
    rest = pool.slice(i + 1);
  }
  const final = size(picks);
  // Alternates: the next names that wouldn't break the sector name cap against the final list.
  const sectorNames = new Map<string, number>();
  for (const s of [...held.map((h) => sectorOf(h.sic2)), ...final.buys.map((b) => b.sector)]) sectorNames.set(s, (sectorNames.get(s) ?? 0) + 1);
  const alternates = rest.filter((c) => (sectorNames.get(sectorOf(c.sic2)) ?? 0) < cfg.sector_max_names).slice(0, cfg.alternates);

  return {
    I, N, n: held.length + picks.length, openSlots,
    buys: final.buys.map(({ tooSmall: _, ...b }) => b),
    alternates, skipped, earningsWatch,
    heldWeights: held.map((h, i) => ({ ticker: h.ticker, w: final.w[i], T: final.T[i] })),
    ...(picks.length < openSlots ? { message: `Only ${picks.length} of ${openSlots} open slots could be filled; the rest stay in cash.` } : {}),
  };
}
