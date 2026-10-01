import "server-only";
// Open positions: nightly trailing-stop update, exit review → sell tickets, month-end top-ups, record-exit.
import { db, fetchAll } from "../db";
import type { MomConfig } from "./config";
import { addTradingDays, tradingDaysBetween, type Calendar } from "./calendar";
import { entryCap, planPortfolio, type Candidate, type Held } from "./sizing";
import { callsToClose } from "./calls";
import { tickerSectors } from "./sector-db";
import { applyLtDeferral, dueDeferrals, exitResult, nightlyStop, reviewPosition, topUpShares, type ExitOrder, type Lot, type Position } from "./stops";
import { isWashBuy, type ClosedLot } from "./risk";

export type LotRow = Lot & {
  highest_close: number | null; disaster_stop: number; disaster_posted: number | null; stop0: number; sigma63: number | null;
  atr20: number | null; earnings_date: string | null; signal_date: string | null; s_close: number | null; stop_updated_on: string | null;
  d_trail: number | null; lt_deferred_reason: string | null; lt_deferred_on: string | null;
};

const nyDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

export async function openLots(): Promise<LotRow[]> {
  const { data } = await db().from("ss_mom_lots").select("*").is("exit_date", null).order("ticker").order("filled_at");
  return (data ?? []) as LotRow[];
}

/**
 * Nightly trail: HC = highest close from the entry day through t; D_t from today's ATR20 and close
 * (snapshot row), Stop_t = max(Stop_{t−1}, HC − D_t), disaster = Stop_t − extra × D_t.
 */
export async function updateStops(t: string, cfg: MomConfig) {
  const lots = (await openLots()).filter((l) => !l.stop_updated_on || l.stop_updated_on < t);
  if (!lots.length) return { updated: 0 };
  const tickers = [...new Set(lots.map((l) => l.ticker))];
  const from = lots.map((l) => nyDay(l.filled_at)).sort()[0];
  const [bars, { data: snap }] = await Promise.all([
    fetchAll<{ ticker: string; d: string; c: number }>((a, b) =>
      db().from("ss_daily_bars").select("ticker, d, c").in("ticker", tickers).gte("d", from).lte("d", t).range(a, b)),
    db().from("ss_mom_snapshots").select("ticker, atr20").eq("signal_date", t).in("ticker", tickers),
  ]);
  const atr = new Map((snap ?? []).map((x) => [x.ticker, x.atr20 as number | null]));
  let updated = 0;
  for (const l of lots) {
    const entry = nyDay(l.filled_at);
    const mine = bars.filter((b) => b.ticker === l.ticker && b.d >= entry);
    if (!mine.length) continue;
    const hc = Math.max(...mine.map((b) => b.c));
    const close = mine.reduce((a, b) => (b.d > a.d ? b : a)).c;
    const n = nightlyStop(l.stop, hc, close, atr.get(l.ticker) ?? null, l.d, cfg);
    await db().from("ss_mom_lots").update({
      highest_close: hc, stop: n.stop, d_trail: n.dTrail, disaster_stop: n.disaster, stop_updated_on: t,
    }).eq("id", l.id);
    updated++;
  }
  return { updated };
}

/** Lots closed at a loss or gain (for wash-sale checks). */
export async function closedLots(sinceDays = 400): Promise<ClosedLot[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const { data } = await db().from("ss_mom_lots").select("ticker, exit_date, pnl").not("exit_date", "is", null).gte("exit_date", since);
  return (data ?? []) as ClosedLot[];
}

/**
 * Exit review for signal date t (triggers 1–5 and 7; 6 is the buying-power command), plus month-end
 * top-ups. Creates sell tickets for the next session; a ticker that already has an open sell ticket is skipped.
 */
export async function exitReview(t: string, kind: "daily" | "weekly" | "monthly", riskOn: boolean | null, cfg: MomConfig, tradeDay: string, cal: Calendar,
  opts: { allowTopups?: boolean; earningsUnchecked?: boolean; m?: number; washBlocked?: Map<string, string> } = {}) {
  const monthEnd = kind === "monthly";
  const m = opts.m ?? 1;
  // Volatility brake trims run on weekly and monthly signals only, never on daily runs.
  const brake = kind !== "daily" && m < cfg.vol_trim_trigger;
  const lots = await openLots();
  if (!lots.length) return { positions: 0, exits: 0, topups: 0 };
  const tickers = [...new Set(lots.map((l) => l.ticker))];
  const [{ data: bars }, { data: tk }, { data: snap }, { data: flags }, { data: openSells }] = await Promise.all([
    db().from("ss_daily_bars").select("ticker, c").eq("d", t).in("ticker", tickers),
    db().from("ss_tickers").select("ticker, active").in("ticker", tickers),
    db().from("ss_mom_snapshots").select("ticker, hold_ok, hold_reason, entry_ok, close, sigma63, atr20, comp_rank").eq("signal_date", t).in("ticker", tickers),
    db().from("ss_data_flags").select("ticker, d").eq("kind", "buyout_news").eq("cleared", false).in("ticker", tickers),
    db().from("ss_mom_tickets").select("ticker").eq("side", "sell").eq("status", "open"),
  ]);
  const { data: calls } = await db().from("ss_mom_calls").select("ticker, contract, contracts").in("status", ["open", "assign_pending"]).in("ticker", tickers);
  const close = new Map((bars ?? []).map((b) => [b.ticker, b.c as number]));
  const info = new Map((tk ?? []).map((x) => [x.ticker, x]));
  const s = new Map((snap ?? []).map((x) => [x.ticker, x]));
  const buyout = new Map((flags ?? []).map((f) => [f.ticker, f.d as string]));
  const selling = new Set((openSells ?? []).map((x) => x.ticker));

  // Month-end targets for kept holdings (trim / top-up / brake) come from the same sizing as new
  // buys, scaled by the volatility brake m.
  const targets = new Map<string, number>();
  const sectors = await tickerSectors(tickers);
  if (monthEnd || brake) {
    const held: Held[] = tickers.map((tk2) => ({
      ticker: tk2, sigma63: s.get(tk2)?.sigma63 ?? lots.find((l) => l.ticker === tk2)?.sigma63 ?? null,
      sector: sectors.get(tk2)!,
      value: lots.filter((l) => l.ticker === tk2).reduce((a, l) => a + l.shares, 0) * (close.get(tk2) ?? 0),
    }));
    const plan = planPortfolio({ cfg, candidates: [] as Candidate[], held, riskOn: true, scale: m });
    for (const h of plan.heldWeights) targets.set(h.ticker, h.T);
  }

  let exits = 0, topups = 0, deferredLots = 0;
  for (const tick of tickers) {
    const mine = lots.filter((l) => l.ticker === tick);
    const p: Position = {
      ticker: tick, lots: mine, close: close.get(tick) ?? null,
      active: info.get(tick)?.active ?? true, holdOk: s.get(tick)?.hold_ok ?? null, holdReason: s.get(tick)?.hold_reason ?? null,
      buyoutNews: buyout.get(tick) ?? null, target: monthEnd ? targets.get(tick) ?? null : null, entryOk: s.get(tick)?.entry_ok ?? false,
      volTarget: brake ? targets.get(tick) ?? null : null,
    };
    const reviewed = reviewPosition(p, { monthEnd, riskOn, cfg });
    // Long-term deferral (triggers 3, 7, 9): lots close to long-term with a gain wait for lt_date.
    const { order: kept, deferred } = applyLtDeferral(reviewed, mine, p.close, t, cfg);
    for (const d of deferred) {
      await db().from("ss_mom_lots").update({
        lt_deferred_trigger: reviewed!.trigger, lt_deferred_shares: d.shares, lt_deferred_on: t,
        lt_deferred_reason: `${reviewed!.reason} Deferred for LT until ${d.lt_date}.`,
      }).eq("id", d.id);
      deferredLots++;
    }
    // Deferrals that are due (lt_date reached, or the gain is gone) are worked now.
    const due = dueDeferrals(mine, p.close, t).filter((l) => !kept?.lots.some((x) => x.id === l.id));
    let order: ExitOrder | null = kept;
    if (due.length) {
      const extra = due.map((l) => ({ id: l.id, shares: Math.min(l.shares, l.lt_deferred_shares ?? l.shares) }));
      const reason = due.map((l) => (t >= l.lt_date ? `Now long-term (${l.lt_date}): ` : "Gain gone, deferral ended: ") + (l.lt_deferred_reason ?? "")).join(" ");
      order = order
        ? { ...order, lots: [...order.lots, ...extra], shares: order.shares + extra.reduce((a, x) => a + x.shares, 0), reason: `${order.reason} ${reason}` }
        : { ticker: tick, trigger: due[0].lt_deferred_trigger as ExitOrder["trigger"], lots: extra, shares: extra.reduce((a, x) => a + x.shares, 0), reason, urgent: false, deadlineDays: 0 };
    }
    if (order && !selling.has(tick)) {
      // Lots on a sell ticket aren't waiting any more.
      await db().from("ss_mom_lots").update({ lt_deferred_trigger: null, lt_deferred_shares: null, lt_deferred_on: null, lt_deferred_reason: null })
        .in("id", order.lots.map((x) => x.id)).not("lt_deferred_trigger", "is", null);
      // "Within 5 trading days" counts the first session worked.
      const deadline = order.deadlineDays ? addTradingDays(cal, tradeDay, order.deadlineDays - 1) : tradeDay;
      const { error } = await db().from("ss_mom_tickets").upsert({
        signal_date: t, kind: "exit", side: "sell", ticker: tick, status: "open", exit_trigger: order.trigger, lots: order.lots,
        shares_to_sell: order.shares, urgent: order.urgent, deadline, trade_date: tradeDay, s_close: p.close ?? 0, cap: 0,
        note: callNote(tick, order.shares, lots, calls ?? []) + order.reason, updated_at: new Date().toISOString(),
      }, { onConflict: "signal_date,kind,side,ticker" });
      if (error) throw new Error(`exit ticket: ${error.message}`);
      exits++;
    } else if (!order && monthEnd && riskOn === true && (opts.allowTopups ?? true) && !opts.washBlocked?.has(tick)) {
      const add = topUpShares(p, cfg);
      const sn = s.get(tick);
      if (add > 0 && sn && p.close != null) {
        await db().from("ss_mom_tickets").upsert({
          signal_date: t, kind: "topup", side: "buy", ticker: tick, status: "open", comp_rank: sn.comp_rank, sector: sectors.get(tick)!,
          sigma63: sn.sigma63, atr20: sn.atr20, t_target: add * p.close, s_close: p.close, cap: entryCap(p.close, cfg),
          planned_shares: add, trade_date: tradeDay, note: `Top-up: under ${cfg.topup_below_mult}× its target ${targets.get(tick)?.toFixed(0)}`,
          earnings_unchecked: !!opts.earningsUnchecked,
        }, { onConflict: "signal_date,kind,side,ticker" });
        topups++;
      }
    }
  }
  // Unfilled sell tickets carry into the next session.
  await db().from("ss_mom_tickets").update({ trade_date: tradeDay, bid: null, ask: null, xp1: null, xp2: null, updated_at: new Date().toISOString() })
    .eq("side", "sell").eq("status", "open").lt("trade_date", tradeDay);
  return { positions: tickers.length, exits, topups, deferredLots, brake };
}

/** "Buy back …" prefix for a sell ticket when open covered calls would be left uncovered. */
function callNote(ticker: string, sell: number, lots: { ticker: string; shares: number }[], calls: { ticker: string; contract: string; contracts: number }[]) {
  const mine = calls.filter((c) => c.ticker === ticker);
  if (!mine.length) return "";
  const held = lots.filter((l) => l.ticker === ticker).reduce((a, l) => a + l.shares, 0);
  const n = callsToClose(held, sell, mine.reduce((a, c) => a + c.contracts, 0));
  return n ? `FIRST buy to close ${n} covered call contract(s) (${mine.map((c) => c.contract).join(", ")}), then sell the shares. ` : "";
}

/** record-exit: close (or split) each lot on the ticket with X, trigger, P&L, R, days held and ST/LT. */
export async function recordExit(ticketId: number, X: number, fees: number, exitedAt: string, cal: Calendar) {
  const { data: t } = await db().from("ss_mom_tickets").select("*").eq("id", ticketId).single();
  if (!t || t.side !== "sell") throw new Error("Sell ticket not found");
  const picks = (t.lots ?? []) as { id: number; shares: number }[];
  const total = picks.reduce((s, p) => s + p.shares, 0);
  const exitDay = nyDay(exitedAt);
  const { data: rows } = await db().from("ss_mom_lots").select("*").in("id", picks.map((p) => p.id));
  for (const pick of picks) {
    const lot = (rows ?? []).find((r) => r.id === pick.id);
    if (!lot || lot.exit_date) continue;
    const lotFees = total ? (fees * pick.shares) / total : 0;
    const res = exitResult(lot, X, pick.shares, lotFees, exitDay);
    const closed = {
      exit_date: exitDay, exit_trigger: t.exit_trigger, exit_price: X, fees: lotFees, pnl: res.pnl, r_multiple: res.r,
      days_held: tradingDaysBetween(cal, nyDay(lot.filled_at), exitDay), term: res.term,
    };
    if (pick.shares >= lot.shares - 1e-9) {
      await db().from("ss_mom_lots").update(closed).eq("id", lot.id);
    } else {
      // Partial sale (trim): the sold shares become their own closed lot; the rest stays open.
      const { id: _id, created_at: _c, ...copy } = lot;
      await db().from("ss_mom_lots").insert({ ...copy, shares: pick.shares, ...closed });
      await db().from("ss_mom_lots").update({ shares: lot.shares - pick.shares }).eq("id", lot.id);
    }
  }
  await db().from("ss_mom_tickets").update({ status: "filled", updated_at: new Date().toISOString() }).eq("id", ticketId);
  // Wash sale: a loss sale with shares of the same stock bought in the 30 days before it.
  const loss = picks.reduce((a, pick) => {
    const lot = (rows ?? []).find((r) => r.id === pick.id);
    return a + (lot ? (X - lot.fill_price) * pick.shares : 0);
  }, 0) - fees;
  if (loss < 0) {
    const from = new Date(Date.parse(exitDay + "T00:00:00Z") - 30 * 86_400_000).toISOString();
    await db().from("ss_mom_lots").update({ wash_sale: true }).eq("ticker", t.ticker).is("exit_date", null)
      .gte("filled_at", from).not("id", "in", `(${picks.map((p) => p.id).join(",")})`);
  }
}

/** wash_sale flag for a new lot: the ticker was sold at a loss within the 30 days before the buy. */
export async function washOnBuy(ticker: string, day: string) {
  return isWashBuy(await closedLots(60), ticker, day);
}
