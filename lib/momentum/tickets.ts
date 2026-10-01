import "server-only";
// Ticket lifecycle: create buy tickets from a weekly/monthly plan, roll unfilled ones into the next
// session (retry rules), promote alternates, and record fills as lots.
import { db, fetchAll } from "../db";
import { capitalAndSlots, type MomConfig } from "./config";
import { addTradingDays, type Calendar } from "./calendar";
import { planPortfolio, type Candidate, type Held } from "./sizing";
import { advanceTicket, fillLevels, type TicketState } from "./orders";
import { tickerSectors, withSectors } from "./sector-db";

export type Ticket = {
  id: number; signal_date: string; kind: string; side: string; ticker: string; status: TicketState["status"];
  alt_order: number | null; comp_rank: number | null; mom_pct: number | null; h52: number | null; days_since_high: number | null;
  sector: string | null; sigma63: number | null; atr20: number | null; w: number | null; t_target: number | null;
  s_close: number; cap: number; planned_shares: number | null; trade_date: string | null; retry_day: number;
  bid: number | null; ask: number | null; lp1: number | null; lp2: number | null; shares_lp1: number | null; shares_lp2: number | null;
  risk_cap_shares: number | null; quoted_at: string | null; note: string | null;
  /** Created while the earnings calendar was unavailable: the blackout wasn't applied. */
  earnings_unchecked?: boolean;
};

type SnapRow = Candidate & { mom_pct: number; h52: number; days_since_high: number };

/** Snapshot rows with their GICS sector key (resolved now from ss_tickers, so every reader buckets alike). */
async function snapshot(t: string): Promise<SnapRow[]> {
  const rows = await fetchAll<Omit<SnapRow, "sector">>((a, b) =>
    db().from("ss_mom_snapshots").select("ticker, comp_rank, close, sigma63, atr20, entry_ok, mom_pct, h52, days_since_high")
      .eq("signal_date", t).order("comp_rank").range(a, b));
  return withSectors(rows);
}

/** Open lots plus live buy tickets from other plans: both occupy slots and count toward sector caps. */
async function occupied(excludePlan?: { signal_date: string; kind: string }): Promise<Held[]> {
  const [{ data: allLots }, { data: tix }, { data: sells }] = await Promise.all([
    db().from("ss_mom_lots").select("ticker, shares, fill_price, sigma63").is("exit_date", null),
    db().from("ss_mom_tickets").select("ticker, sector, sigma63, t_target, signal_date, kind").eq("side", "buy").eq("status", "open").neq("kind", "topup"),
    db().from("ss_mom_tickets").select("ticker, exit_trigger").eq("side", "sell").eq("status", "open"),
  ]);
  // Exit review runs first: positions with an open full-exit ticket (any trigger but a trim) aren't kept.
  const leaving = new Set((sells ?? []).filter((x) => x.exit_trigger !== 7).map((x) => x.ticker));
  const lots = (allLots ?? []).filter((l) => !leaving.has(l.ticker));
  const sectors = await tickerSectors([...lots.map((l) => l.ticker), ...(tix ?? []).map((t) => t.ticker as string)]);
  const held: Held[] = lots.map((l) => ({
    ticker: l.ticker, sigma63: l.sigma63, sector: sectors.get(l.ticker)!, value: l.shares * l.fill_price,
  }));
  // Several lots of one ticker (top-ups) are one holding.
  const merged = new Map<string, Held>();
  for (const h of held) {
    const m = merged.get(h.ticker);
    if (m) m.value += h.value; else merged.set(h.ticker, { ...h });
  }
  held.splice(0, held.length, ...merged.values());
  for (const t of tix ?? []) {
    if (excludePlan && t.signal_date === excludePlan.signal_date && t.kind === excludePlan.kind) continue;
    // Re-resolved rather than read from the ticket, so tickets made before GICS buckets still count right.
    held.push({ ticker: t.ticker, sigma63: t.sigma63, sector: sectors.get(t.ticker)!, value: t.t_target ?? 0 });
  }
  return held;
}

/** Tickers never offered as new buys: already owned (any open lot) or being sold. */
async function ownedOrSelling(): Promise<Set<string>> {
  const [{ data: lots }, { data: sells }] = await Promise.all([
    db().from("ss_mom_lots").select("ticker").is("exit_date", null),
    db().from("ss_mom_tickets").select("ticker").eq("side", "sell").eq("status", "open"),
  ]);
  return new Set([...(lots ?? []), ...(sells ?? [])].map((x) => x.ticker));
}

async function earningsWithin(cal: Calendar, t: string, cfg: MomConfig): Promise<Set<string>> {
  const until = addTradingDays(cal, t, cfg.earnings_blackout_days);
  const { data } = await db().from("ss_earnings_calendar").select("ticker").gt("report_date", t).lte("report_date", until);
  return new Set((data ?? []).map((r) => r.ticker));
}

/** Tickets for a weekly refill or monthly rebalance. Idempotent per (signal date, kind). */
export async function createTickets(t: string, kind: "weekly" | "monthly", cfg: MomConfig, riskOn: boolean | null, tradeDay: string, cal: Calendar,
  opts: { earningsUnchecked?: boolean } = {}) {
  if (riskOn !== true) {
    // Regime exit: no buys or refills; open buy tickets are cancelled.
    const { data } = await db().from("ss_mom_tickets").update({ status: "cancelled", note: "Regime not risk-on", updated_at: new Date().toISOString() })
      .eq("side", "buy").in("status", ["open", "alternate"]).select("id");
    return { created: 0, cancelled: data?.length ?? 0 };
  }
  const { count } = await db().from("ss_mom_tickets").select("id", { count: "exact", head: true }).eq("signal_date", t).eq("kind", kind);
  if (count) return { created: 0, existing: count };
  const [snap, held, earnings, busy] = await Promise.all([snapshot(t), occupied(), earningsWithin(cal, t, cfg), ownedOrSelling()]);
  const plan = planPortfolio({ cfg, candidates: snap.filter((x) => !busy.has(x.ticker)), held, riskOn, earnings });
  const byTicker = new Map(snap.map((s) => [s.ticker, s]));
  const rows = [
    ...plan.buys.map((b) => ({
      status: "open", alt_order: null, ticker: b.ticker, comp_rank: b.comp_rank, sector: b.sector, sigma63: b.sigma63,
      atr20: byTicker.get(b.ticker)?.atr20 ?? null, w: b.w, t_target: b.T, s_close: b.S, cap: b.cap, planned_shares: b.shares,
      risk_cap_shares: b.byRisk, trade_date: tradeDay,
    })),
    ...plan.alternates.map((a, i) => ({
      status: "alternate", alt_order: i + 1, ticker: a.ticker, comp_rank: a.comp_rank, sector: a.sector, sigma63: a.sigma63,
      atr20: a.atr20, w: null, t_target: null, s_close: a.close, cap: null, planned_shares: null, risk_cap_shares: null, trade_date: null,
    })),
  ].map((r) => {
    const s = byTicker.get(r.ticker);
    return {
      ...r, signal_date: t, kind, side: "buy", mom_pct: s?.mom_pct ?? null, h52: s?.h52 ?? null, days_since_high: s?.days_since_high ?? null,
      // No usable earnings calendar: the blackout couldn't be applied, so check each name by hand.
      earnings_unchecked: !!opts.earningsUnchecked,
    };
  });
  if (rows.length) {
    const { error } = await db().from("ss_mom_tickets").insert(rows);
    if (error) throw new Error(`ss_mom_tickets: ${error.message}`);
  }
  return { created: plan.buys.length, alternates: plan.alternates.length, openSlots: plan.openSlots, message: plan.message ?? null };
}

/**
 * Give a dropped ticket's slot to the next name: re-plan the same signal date without the dropped
 * names, keep this plan's live tickets, and open the first new name (normally the next alternate).
 */
export async function promoteAlternate(plan: { signal_date: string; kind: string }, tradeDay: string, cfg: MomConfig, cal: Calendar,
  opts: { earningsUnchecked?: boolean } = {}) {
  const { data: mine } = await db().from("ss_mom_tickets").select("id, ticker, status").eq("signal_date", plan.signal_date).eq("kind", plan.kind).eq("side", "buy");
  const dropped = new Set((mine ?? []).filter((m) => m.status === "dropped" || m.status === "cancelled").map((m) => m.ticker));
  const live = new Set((mine ?? []).filter((m) => m.status === "open" || m.status === "filled").map((m) => m.ticker));
  const [snap, held, earnings, busy] = await Promise.all([snapshot(plan.signal_date), occupied(plan), earningsWithin(cal, plan.signal_date, cfg), ownedOrSelling()]);
  // This plan's filled names are already lots (in `held`); its open ones are re-picked from the snapshot.
  const lots = new Set(held.map((h) => h.ticker));
  const p = planPortfolio({ cfg, candidates: snap.filter((s) => !dropped.has(s.ticker) && !busy.has(s.ticker)), held, riskOn: true, earnings });
  const next = p.buys.find((b) => !live.has(b.ticker) && !lots.has(b.ticker));
  if (!next) return null;
  const s = snap.find((x) => x.ticker === next.ticker)!;
  const row = {
    signal_date: plan.signal_date, kind: plan.kind, side: "buy", ticker: next.ticker, status: "open", alt_order: null,
    comp_rank: next.comp_rank, mom_pct: s.mom_pct, h52: s.h52, days_since_high: s.days_since_high, sector: next.sector,
    sigma63: next.sigma63, atr20: s.atr20, w: next.w, t_target: next.T, s_close: next.S, cap: next.cap, planned_shares: next.shares,
    risk_cap_shares: next.byRisk, trade_date: tradeDay, retry_day: 1, note: "Promoted to fill a dropped slot", updated_at: new Date().toISOString(),
    earnings_unchecked: !!opts.earningsUnchecked,
  };
  const { error } = await db().from("ss_mom_tickets").upsert(row, { onConflict: "signal_date,kind,side,ticker" });
  if (error) throw new Error(`ss_mom_tickets: ${error.message}`);
  return next.ticker;
}

/** Roll every open, unfilled buy ticket into `tradeDay` (retry rules), promoting alternates as slots free up. */
/**
 * `allowNewBuys: false` (data-quality gate) still rolls and drops tickets, but leaves a dropped
 * slot empty instead of promoting the next name.
 */
export async function advanceTickets(latestSignal: string, tradeDay: string, cfg: MomConfig, cal: Calendar,
  opts: { allowNewBuys?: boolean; earningsUnchecked?: boolean } = {}) {
  const allowNewBuys = opts.allowNewBuys ?? true;
  const { data: open } = await db().from("ss_mom_tickets").select("*").eq("side", "buy").eq("status", "open").lt("trade_date", tradeDay);
  if (!open?.length) return { advanced: 0, dropped: 0, promoted: [] as string[] };
  const { data: latest } = await db().from("ss_mom_snapshots").select("ticker, entry_ok, close")
    .eq("signal_date", latestSignal).in("ticker", open.map((o) => o.ticker));
  const now = new Map((latest ?? []).map((l) => [l.ticker, l as { entry_ok: boolean; close: number }]));
  let dropped = 0;
  const promoted: string[] = [];
  for (const t of open as Ticket[]) {
    const next = advanceTicket(t, tradeDay, now.get(t.ticker) ?? null, cfg);
    const { promote } = next;
    const patch = {
      status: next.status, retry_day: next.retry_day, trade_date: next.trade_date, s_close: next.s_close, cap: next.cap,
      note: next.note ?? t.note, updated_at: new Date().toISOString(),
      // A new session needs a new quote.
      bid: null, ask: null, lp1: null, lp2: null, shares_lp1: null, shares_lp2: null, quoted_at: null,
    };
    await db().from("ss_mom_tickets").update(patch).eq("id", t.id);
    if (promote) {
      dropped++;
      // A dropped top-up just lapses; only new-position slots go to the next name.
      const p = t.kind === "topup" || !allowNewBuys ? null : await promoteAlternate(t, tradeDay, cfg, cal, { earningsUnchecked: opts.earningsUnchecked });
      if (p) promoted.push(p);
    }
  }
  return { advanced: open.length - dropped, dropped, promoted };
}

/** record-fill: store the lot with D, Stop0, disaster stop, earnings and long-term dates; close the ticket. */
export async function recordFill(ticketId: number, F: number, shares: number, filledAt: string, cfg: MomConfig) {
  const { data: t } = await db().from("ss_mom_tickets").select("*").eq("id", ticketId).single();
  if (!t) throw new Error("Ticket not found");
  const ticket = t as Ticket;
  if (ticket.atr20 == null) throw new Error("Ticket has no ATR20 from its signal date");
  const day = filledAt.slice(0, 10);
  const lv = fillLevels(F, ticket.atr20, day, cfg);
  const [{ data: tk }, { data: er }] = await Promise.all([
    db().from("ss_tickers").select("composite_figi").eq("ticker", ticket.ticker).maybeSingle(),
    db().from("ss_earnings_calendar").select("report_date").eq("ticker", ticket.ticker).gte("report_date", day).order("report_date").limit(1),
  ]);
  const { I, N } = capitalAndSlots(cfg);
  const { error } = await db().from("ss_mom_lots").insert({
    ticker: ticket.ticker, figi: tk?.composite_figi ?? null, ticket_id: ticket.id, signal_date: ticket.signal_date,
    s_close: ticket.s_close, mom_pct: ticket.mom_pct, h52: ticket.h52, days_since_high: ticket.days_since_high, comp_rank: ticket.comp_rank,
    sigma63: ticket.sigma63, atr20: ticket.atr20, regime: "risk-on", b: cfg.B, e: cfg.E, i: I, n: N, w: ticket.w, t_target: ticket.t_target,
    shares, risk_cap_shares: ticket.risk_cap_shares, lp1: ticket.lp1, lp2: ticket.lp2, fill_price: F, filled_at: filledAt,
    d: lv.D, stop0: lv.stop0, stop: lv.stop0, highest_close: F, disaster_stop: lv.disaster,
    earnings_date: er?.[0]?.report_date ?? null, lt_date: lv.ltDate,
    slippage_s_bps: ticket.s_close ? Math.round((F / ticket.s_close - 1) * 10_000 * 10) / 10 : null,
    slippage_lp_bps: ticket.lp1 ? Math.round((F / ticket.lp1 - 1) * 10_000 * 10) / 10 : null,
  });
  if (error) throw new Error(`ss_mom_lots: ${error.message}`);
  await db().from("ss_mom_tickets").update({ status: "filled", updated_at: new Date().toISOString() }).eq("id", ticket.id);
  return lv;
}
