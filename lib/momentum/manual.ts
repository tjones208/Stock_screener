import "server-only";
// Positions added by hand: a stock you bought outside a ticket, or more shares of a holding.
// Always allowed; rule breaks are shown before you confirm and recorded on the lot.
import { db } from "../db";
import { capitalAndSlots } from "./config";
import { getMomConfig } from "./jobs";
import { fillLevels } from "./orders";
import { planPortfolio, positionShares, sectorOf, stopDistance, type Held } from "./sizing";
import { manualWarnings } from "./manual-rules";

export type ManualPreview = {
  ticker: string; name: string | null; holding: boolean; close: number | null; atr: number | null; D: number | null;
  target: number | null; valueBefore: number; suggestedShares: number | null; warnings: string[]; error?: string;
  price: number | null; shares: number | null;
};

async function context(ticker: string) {
  const cfg = await getMomConfig();
  const { I, N } = capitalAndSlots(cfg);
  const { data: runs } = await db().from("ss_mom_runs").select("signal_date, kind, regime").order("signal_date", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  const run = runs?.[0];
  const t = run?.signal_date as string | undefined;
  const [{ data: tk }, { data: snap }, { data: lots }] = await Promise.all([
    db().from("ss_tickers").select("ticker, name, sic_code").eq("ticker", ticker).maybeSingle(),
    t ? db().from("ss_mom_snapshots").select("*").eq("signal_date", t).eq("ticker", ticker).maybeSingle() : Promise.resolve({ data: null }),
    db().from("ss_mom_lots").select("ticker, shares, fill_price, sigma63").is("exit_date", null),
  ]);
  // Not in the ranking: compute ATR / σ from its own bars so it still gets a proper stop.
  let m: { close: number; atr: number | null; sigma: number | null } | null = snap
    ? { close: snap.close, atr: snap.atr20, sigma: snap.sigma63 } : null;
  if (!m && t) {
    const { data } = await db().rpc("ss_mom_metrics", { p_t: t, p_tickers: [ticker] });
    const r = (data as { close: number; atr: number | null; sigma: number | null }[] | null)?.[0];
    if (r) m = { close: r.close, atr: r.atr, sigma: r.sigma };
  }
  const { data: sics } = await db().from("ss_tickers").select("ticker, sic_code").in("ticker", [...new Set((lots ?? []).map((l) => l.ticker))]);
  const sic = new Map((sics ?? []).map((x) => [x.ticker, x.sic_code as string | null]));
  const { data: closes } = await db().from("ss_indicators").select("ticker, close").in("ticker", [...new Set((lots ?? []).map((l) => l.ticker))]);
  const last = new Map((closes ?? []).map((x) => [x.ticker, x.close as number]));
  const held = new Map<string, Held>();
  for (const l of lots ?? []) {
    const h = held.get(l.ticker) ?? { ticker: l.ticker, sigma63: l.sigma63, sic2: sic.get(l.ticker)?.slice(0, 2) ?? null, value: 0 };
    h.value += l.shares * (last.get(l.ticker) ?? l.fill_price);
    held.set(l.ticker, h);
  }
  return { cfg, I, N, run, t, tk, snap, m, held };
}

/** Everything the add form shows before you confirm: suggested shares and the rule warnings. */
export async function previewManual(tickerIn: string, priceIn?: number, sharesIn?: number): Promise<ManualPreview> {
  const ticker = tickerIn.trim().toUpperCase();
  const c = await context(ticker);
  const base = { ticker, name: c.tk?.name ?? null, holding: c.held.has(ticker), valueBefore: c.held.get(ticker)?.value ?? 0 };
  if (!c.tk) return { ...base, close: null, atr: null, D: null, target: null, suggestedShares: null, warnings: [], price: null, shares: null, error: `${ticker} isn't a known ticker.` };
  if (!c.m || c.m.atr == null) {
    return { ...base, close: c.m?.close ?? null, atr: null, D: null, target: null, suggestedShares: null, warnings: [], price: null, shares: null,
      error: `${ticker} doesn't have enough price history in the app to set a stop.` };
  }
  const price = priceIn && priceIn > 0 ? priceIn : c.m.close;
  const D = stopDistance(c.m.atr, price, c.cfg);
  const sector = sectorOf(c.snap?.sic2 ?? c.tk.sic_code?.slice(0, 2));
  // Target T with this stock in the portfolio (same sizing as the strategy's own buys).
  const heldList = [...c.held.values()];
  const withIt = base.holding ? heldList : [...heldList, { ticker, sigma63: c.m.sigma, sic2: c.snap?.sic2 ?? c.tk.sic_code?.slice(0, 2) ?? null, value: 0 }];
  const plan = planPortfolio({ cfg: c.cfg, candidates: [], held: withIt, riskOn: true });
  const target = plan.heldWeights.find((h) => h.ticker === ticker)?.T ?? null;
  const suggested = target == null ? null : base.holding
    ? Math.max(0, Math.floor((target - base.valueBefore) / price))
    : positionShares(target, price, D, c.cfg).shares;
  const shares = sharesIn && sharesIn > 0 ? sharesIn : suggested && suggested > 0 ? suggested : null;
  const sameSector = [...c.held.values()].filter((h) => sectorOf(h.sic2) === sector);
  const warnings = shares == null ? [] : manualWarnings({
    holding: base.holding, inUniverse: !!c.snap, entryOk: !!c.snap?.entry_ok, riskOn: (c.run?.regime as { riskOn?: boolean } | null)?.riskOn ?? null,
    rebalanceDay: c.run?.kind === "monthly", heldCount: c.held.size, N: c.N, I: c.I, sector,
    sectorNamesAfter: sameSector.length + (base.holding ? 0 : 1),
    sectorDollarsAfter: sameSector.reduce((a, h) => a + h.value, 0) + shares * price,
    shares, price, D, target, valueBefore: base.valueBefore,
  }, c.cfg);
  return { ...base, close: c.m.close, atr: c.m.atr, D, target, suggestedShares: suggested, warnings, price, shares };
}

/** Create the lot (stops from the latest ATR20); warnings become its rule-break note. Returns the lot id. */
export async function addManualLot(ticker: string, F: number, shares: number, filledAt: string): Promise<number> {
  const p = await previewManual(ticker, F, shares);
  if (p.error || p.atr == null) throw new Error(p.error ?? "Can't set a stop for this stock.");
  const c = await context(p.ticker);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(filledAt));
  const lv = fillLevels(F, p.atr, day, c.cfg);
  const [{ data: fig }, { data: er }] = await Promise.all([
    db().from("ss_tickers").select("composite_figi").eq("ticker", p.ticker).maybeSingle(),
    db().from("ss_earnings_calendar").select("report_date").eq("ticker", p.ticker).gte("report_date", day).order("report_date").limit(1),
  ]);
  const riskOn = (c.run?.regime as { riskOn?: boolean } | null)?.riskOn;
  const { data, error } = await db().from("ss_mom_lots").insert({
    ticker: p.ticker, figi: fig?.composite_figi ?? null, ticket_id: null, signal_date: c.t ?? null, s_close: p.close,
    mom_pct: c.snap?.mom_pct ?? null, h52: c.snap?.h52 ?? null, days_since_high: c.snap?.days_since_high ?? null, comp_rank: c.snap?.comp_rank ?? null,
    sigma63: c.m?.sigma ?? null, atr20: p.atr, regime: riskOn == null ? "unknown" : riskOn ? "risk-on" : "risk-off",
    b: c.cfg.B, e: c.cfg.E, i: c.I, n: c.N, t_target: p.target, shares, fill_price: F, filled_at: filledAt,
    d: lv.D, stop0: lv.stop0, stop: lv.stop0, highest_close: F, disaster_stop: lv.disaster,
    earnings_date: er?.[0]?.report_date ?? null, lt_date: lv.ltDate,
    slippage_s_bps: p.close ? Math.round((F / p.close - 1) * 100_000) / 10 : null,
    rule_broken: p.warnings.length > 0,
    rule_note: [p.holding ? "Added shares by hand." : "Added by hand.", ...p.warnings].join(" "),
  }).select("id").single();
  if (error) throw new Error(`ss_mom_lots: ${error.message}`);
  return data.id as number;
}
