import "server-only";
// Covered calls on momentum positions, sold in your broker and recorded here: nightly eligibility
// (which positions have uncovered round lots and which expirations fit), expiry settlement, and
// recording sales, buy-backs and assignments (a called-away position is an exit at the strike).
import { db } from "../db";
import type { MomConfig } from "./config";
import type { Calendar } from "./calendar";
import { callsToClose as callsToCloseCount, callWindow, coverableContracts } from "./calls";
import { pickLots, type Lot } from "./stops";
import { recordExit } from "./positions";

export type CallRow = {
  id: number; ticker: string; contract: string; expiration: string; strike: number; contracts: number; premium: number;
  opened_at: string; status: string; close_price: number | null; closed_at: string | null; note: string | null;
};

export async function openCalls(): Promise<CallRow[]> {
  const { data } = await db().from("ss_mom_calls").select("*").in("status", ["open", "assign_pending"]).order("expiration");
  return (data ?? []) as CallRow[];
}

/**
 * After an expiration date: a call that finished out of the money expired worthless; one that
 * finished at or above the strike was most likely assigned and waits for you to confirm.
 */
export async function settleExpiredCalls(t: string) {
  const due = (await openCalls()).filter((c) => c.status === "open" && c.expiration <= t);
  let expired = 0, pending = 0;
  for (const c of due) {
    const { data: bar } = await db().from("ss_daily_bars").select("c").eq("ticker", c.ticker).eq("d", c.expiration).maybeSingle();
    if (!bar) continue; // expiration-day bar not loaded yet
    if (bar.c < c.strike) {
      await db().from("ss_mom_calls").update({ status: "expired", close_price: 0, closed_at: `${c.expiration}T20:00:00Z`, note: `Expired worthless (closed ${bar.c.toFixed(2)} < ${c.strike})` }).eq("id", c.id);
      expired++;
    } else {
      await db().from("ss_mom_calls").update({ status: "assign_pending", note: `Closed ${bar.c.toFixed(2)} ≥ strike ${c.strike} on expiration: likely called away` }).eq("id", c.id);
      pending++;
    }
  }
  return { expired, pending };
}

/**
 * Nightly: positions with uncovered round lots of 100 shares (skipping ones being sold), with the
 * expiration range that fits: at least call_min_dte days out, by this month's last trading day and
 * before the next earnings date.
 */
export async function refreshCallIdeas(today: string, cfg: MomConfig, cal: Calendar) {
  if (!cfg.covered_calls) {
    await db().from("ss_mom_call_ideas").delete().neq("ticker", "");
    return { eligible: 0, skipped: "covered calls off" };
  }
  const [{ data: lots }, calls, { data: sells }] = await Promise.all([
    db().from("ss_mom_lots").select("ticker, shares, earnings_date").is("exit_date", null),
    openCalls(),
    db().from("ss_mom_tickets").select("ticker").eq("side", "sell").eq("status", "open"),
  ]);
  const selling = new Set((sells ?? []).map((x) => x.ticker));
  const pos = new Map<string, { shares: number; earnings: string | null }>();
  for (const l of lots ?? []) {
    const p = pos.get(l.ticker) ?? { shares: 0, earnings: null };
    p.shares += l.shares;
    if (l.earnings_date && (!p.earnings || l.earnings_date < p.earnings)) p.earnings = l.earnings_date;
    pos.set(l.ticker, p);
  }
  const rows = [];
  for (const [ticker, p] of pos) {
    const open = calls.filter((c) => c.ticker === ticker).reduce((a, c) => a + c.contracts, 0);
    const n = coverableContracts(p.shares, open);
    if (!n || selling.has(ticker)) continue;
    const w = callWindow(cal, today, p.earnings, cfg);
    rows.push({
      ticker, as_of: today, contracts: n, exp_earliest: w?.gte ?? null, exp_latest: w?.lte ?? null, updated_at: new Date().toISOString(),
      note: w ? (p.earnings && w.lte < w.monthEnd ? `Earnings ${p.earnings}: expire by ${w.lte}.` : null)
        : "Too close to month-end or earnings to sell a call this month.",
    });
  }
  await db().from("ss_mom_call_ideas").delete().neq("ticker", "");
  if (rows.length) await db().from("ss_mom_call_ideas").insert(rows);
  return { eligible: rows.length };
}

export async function recordCallSold(ticker: string, contract: string, expiration: string, strike: number, contracts: number, premium: number, openedAt: string) {
  const { data: lots } = await db().from("ss_mom_lots").select("shares").eq("ticker", ticker).is("exit_date", null);
  const shares = (lots ?? []).reduce((a, l) => a + l.shares, 0);
  const open = (await openCalls()).filter((c) => c.ticker === ticker).reduce((a, c) => a + c.contracts, 0);
  if (contracts > coverableContracts(shares, open)) throw new Error(`Only ${coverableContracts(shares, open)} contract(s) are covered by your ${ticker} shares.`);
  // Flag (but allow) a call that outlives the month-end rebalance or earnings: it could block a scheduled exit.
  const { data: idea } = await db().from("ss_mom_call_ideas").select("exp_latest").eq("ticker", ticker).maybeSingle();
  const note = idea?.exp_latest && expiration > idea.exp_latest
    ? `Expires after ${idea.exp_latest} (month-end rebalance or earnings): it may have to be bought back before a scheduled sale.` : null;
  const { error } = await db().from("ss_mom_calls").insert({ ticker, contract, expiration, strike, contracts, premium, opened_at: openedAt, note });
  if (error) throw new Error(`ss_mom_calls: ${error.message}`);
  await db().from("ss_mom_call_ideas").delete().eq("ticker", ticker);
}

export async function closeCall(id: number, status: "bought_back" | "expired", price: number, at: string) {
  await db().from("ss_mom_calls").update({ status, close_price: price, closed_at: at }).eq("id", id);
}

/** Called away: sell 100 × contracts shares at the strike (losing lots first, then highest cost) as exit trigger 8. */
export async function confirmAssignment(id: number, cal: Calendar, fractional: boolean) {
  const { data: c } = await db().from("ss_mom_calls").select("*").eq("id", id).single();
  if (!c) throw new Error("Call not found");
  const call = c as CallRow;
  const { data: lots } = await db().from("ss_mom_lots").select("*").eq("ticker", call.ticker).is("exit_date", null);
  const picks = pickLots((lots ?? []) as Lot[], call.contracts * 100, call.strike, fractional);
  const at = `${call.expiration}T20:00:00Z`;
  const { data: t, error } = await db().from("ss_mom_tickets").insert({
    signal_date: call.expiration, kind: "assigned", side: "sell", ticker: call.ticker, status: "open", exit_trigger: 8, lots: picks,
    shares_to_sell: picks.reduce((a, p) => a + p.shares, 0), trade_date: call.expiration, s_close: call.strike, cap: 0,
    note: `Called away at ${call.strike} (${call.contract})`,
  }).select("id").single();
  if (error || !t) throw new Error(`assignment ticket: ${error?.message}`);
  await recordExit(t.id as number, call.strike, 0, at, cal);
  await db().from("ss_mom_calls").update({ status: "assigned", close_price: 0, closed_at: at }).eq("id", id);
}

/** When an exit is recorded: close the calls that selling these shares uncovers, at the buy-back price. */
export async function closeCallsForExit(ticker: string, sharesSold: number, sharesHeldBefore: number, price: number, at: string) {
  const calls = (await openCalls()).filter((c) => c.ticker === ticker && c.status === "open");
  let n = callsToCloseCount(sharesHeldBefore, sharesSold, calls.reduce((a, c) => a + c.contracts, 0));
  for (const c of calls) {
    if (n <= 0) break;
    if (c.contracts <= n) {
      await closeCall(c.id, "bought_back", price, at);
      n -= c.contracts;
    } else {
      // Close part of a multi-contract call: the closed part becomes its own row.
      const { id: _id, ...rest } = c;
      await db().from("ss_mom_calls").insert({ ...rest, contracts: n, status: "bought_back", close_price: price, closed_at: at });
      await db().from("ss_mom_calls").update({ contracts: c.contracts - n }).eq("id", c.id);
      n = 0;
    }
  }
}
