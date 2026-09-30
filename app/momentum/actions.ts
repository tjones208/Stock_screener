"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, upsertChunks } from "@/lib/db";
import { MOM_DEFAULTS, normalizeMomConfig, type MomKey } from "@/lib/momentum/config";
import { getMomConfig, loadCalendar, setMomConfig } from "@/lib/momentum/jobs";
import { buyLimits, exitLimits, sharesAt } from "@/lib/momentum/orders";
import { recordExit } from "@/lib/momentum/positions";
import { promoteAlternate, recordFill } from "@/lib/momentum/tickets";
import { addManualLot } from "@/lib/momentum/manual";
import { closeCall, closeCallsForExit, confirmAssignment, recordCallSold } from "@/lib/momentum/covered";

export async function saveMomConfig(form: FormData) {
  const current = await getMomConfig();
  const input: Record<string, unknown> = { ...current };
  for (const k of Object.keys(MOM_DEFAULTS) as MomKey[]) {
    if (typeof MOM_DEFAULTS[k] === "boolean") input[k] = form.get(k) === "on";
    else if (form.has(k)) input[k] = form.get(k);
  }
  await setMomConfig(normalizeMomConfig(input));
  revalidatePath("/momentum");
}

export async function clearFlag(form: FormData) {
  await db().from("ss_data_flags").update({ cleared: true, cleared_at: new Date().toISOString() })
    .eq("ticker", String(form.get("ticker"))).eq("kind", String(form.get("kind"))).eq("d", String(form.get("d")));
  revalidatePath("/momentum");
}

/**
 * Earnings CSV from the broker: a header row naming a ticker/symbol column and a date column
 * (report date / earnings date / date). Dates as YYYY-MM-DD or M/D/YYYY. Replaces the whole calendar.
 */
export async function uploadEarnings(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return;
  const lines = (await file.text()).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return;
  const split = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const ti = head.findIndex((h) => /^(ticker|symbol)$/.test(h));
  const di = head.findIndex((h) => /(report|earnings).*date|^date$/.test(h));
  if (ti < 0 || di < 0) throw new Error("CSV needs a ticker (or symbol) column and a report date column.");
  const iso = (s: string) => {
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  };
  const rows = new Map<string, { ticker: string; report_date: string }>();
  for (const l of lines.slice(1)) {
    const c = split(l);
    const ticker = (c[ti] ?? "").toUpperCase();
    const report_date = iso(c[di] ?? "");
    if (ticker && report_date) rows.set(`${ticker}|${report_date}`, { ticker, report_date });
  }
  await db().from("ss_earnings_calendar").delete().gte("report_date", "1900-01-01");
  await upsertChunks("ss_earnings_calendar", [...rows.values()], "ticker,report_date");
  revalidatePath("/momentum");
}

/** 09:45 quotes for every open buy ticket on the form → LP1 / LP2 and shares at each. */
export async function quoteTickets(form: FormData) {
  const cfg = await getMomConfig();
  const ids = form.getAll("id").map(Number).filter(Boolean);
  const { data: tix } = await db().from("ss_mom_tickets").select("id, t_target, atr20, cap").in("id", ids);
  for (const t of tix ?? []) {
    const bid = Number(form.get(`bid_${t.id}`));
    const ask = Number(form.get(`ask_${t.id}`));
    if (!form.get(`bid_${t.id}`) || !form.get(`ask_${t.id}`)) continue;
    const r = buyLimits(bid, ask, t.cap);
    const base = { bid, ask, quoted_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if ("error" in r) continue;
    if (r.noBuy) {
      await db().from("ss_mom_tickets").update({ ...base, lp1: null, lp2: null, shares_lp1: null, shares_lp2: null, note: r.reason }).eq("id", t.id);
      continue;
    }
    const s1 = sharesAt(t.t_target, r.lp1, t.atr20, cfg);
    const s2 = sharesAt(t.t_target, r.lp2, t.atr20, cfg);
    const note = s1.tooSmall ? "Too few shares at LP1 for the target (rule 6.7): skip and use the next alternate." : null;
    await db().from("ss_mom_tickets").update({
      ...base, lp1: r.lp1, lp2: r.lp2, shares_lp1: s1.shares, shares_lp2: s2.shares, risk_cap_shares: s1.byRisk, note,
    }).eq("id", t.id);
  }
  revalidatePath("/momentum");
}

export async function fillTicket(form: FormData) {
  const cfg = await getMomConfig();
  const id = Number(form.get("id"));
  const price = Number(form.get("price"));
  const shares = Number(form.get("shares"));
  const at = String(form.get("filled_at") || "");
  if (!(id > 0) || !(price > 0) || !(shares > 0)) throw new Error("Enter the average fill price and the shares filled.");
  // datetime-local has no zone; fills are entered in New York time (EST or EDT for that date).
  const filledAt = at ? nyLocalToIso(at) : new Date().toISOString();
  await recordFill(id, price, shares, filledAt, cfg);
  revalidatePath("/momentum");
}

export async function dropTicket(form: FormData) {
  const id = Number(form.get("id"));
  const { data: t } = await db().from("ss_mom_tickets").update({ status: "dropped", note: "Dropped by hand", updated_at: new Date().toISOString() })
    .eq("id", id).select("signal_date, kind, trade_date").single();
  if (t) await promoteAlternate(t, t.trade_date, await getMomConfig(), await loadCalendar());
  revalidatePath("/momentum");
}

function nyLocalToIso(local: string): string {
  const guess = new Date(`${local}:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(guess).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5"; // e.g. "GMT-4"
  const hours = Number(off.replace("GMT", "") || 0);
  return new Date(guess.getTime() - hours * 3_600_000).toISOString();
}

/** 09:45 quotes for open sell tickets → XP1 (mid − ¼ spread) and XP2 (bid). */
export async function quoteExits(form: FormData) {
  for (const id of form.getAll("id").map(Number).filter(Boolean)) {
    const bid = Number(form.get(`bid_${id}`)), ask = Number(form.get(`ask_${id}`));
    if (!(bid > 0) || !(ask >= bid)) continue;
    const { xp1, xp2 } = exitLimits(bid, ask);
    await db().from("ss_mom_tickets").update({ bid, ask, xp1, xp2, quoted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
  }
  revalidatePath("/momentum");
}

export async function exitTicket(form: FormData) {
  const id = Number(form.get("id"));
  const price = Number(form.get("price"));
  const fees = Number(form.get("fees") || 0);
  const at = String(form.get("exited_at") || "");
  if (!(id > 0) || !(price > 0) || !(fees >= 0)) throw new Error("Enter the average exit price (and fees, if any).");
  const when = at ? nyLocalToIso(at) : new Date().toISOString();
  const callPrice = form.get("call_price");
  if (callPrice !== null && String(callPrice) !== "") {
    const { data: t } = await db().from("ss_mom_tickets").select("ticker, shares_to_sell").eq("id", id).single();
    const { data: lots } = await db().from("ss_mom_lots").select("shares").eq("ticker", t?.ticker ?? "").is("exit_date", null);
    if (t) await closeCallsForExit(t.ticker, t.shares_to_sell, (lots ?? []).reduce((a, l) => a + l.shares, 0), Number(callPrice), when);
  }
  await recordExit(id, price, fees, when, await loadCalendar());
  revalidatePath("/momentum");
}

/** The disaster stop shown was placed (or moved) at the broker as a GTC stop-market order. */
export async function markDisasterPosted(form: FormData) {
  const ids = form.getAll("lot").map(Number).filter(Boolean);
  const { data } = await db().from("ss_mom_lots").select("id, disaster_stop").in("id", ids);
  for (const l of data ?? []) await db().from("ss_mom_lots").update({ disaster_posted: l.disaster_stop }).eq("id", l.id);
  revalidatePath("/momentum");
}

/** "Add to positions": a stock bought outside a ticket, or more shares of a holding. */
export async function addPosition(form: FormData) {
  const ticker = String(form.get("add") ?? "").trim().toUpperCase();
  const price = Number(form.get("price"));
  const shares = Number(form.get("shares"));
  const at = String(form.get("filled_at") || "");
  if (!ticker || !(price > 0) || !(shares > 0)) throw new Error("Enter the ticker, your average price and the shares.");
  const id = await addManualLot(ticker, price, shares, at ? nyLocalToIso(at) : new Date().toISOString());
  revalidatePath("/momentum");
  redirect(`/momentum?added=${id}#hold`);
}

/** Undo a hand-added lot (only lots not created by a ticket and not yet sold). */
export async function undoLot(form: FormData) {
  await db().from("ss_mom_lots").delete().eq("id", Number(form.get("id"))).is("ticket_id", null).is("exit_date", null);
  revalidatePath("/momentum");
  redirect("/momentum#hold");
}

/** "I sold this call": record a covered call written against a position's round lots. */
export async function sellCall(form: FormData) {
  const ticker = String(form.get("ticker") ?? "").toUpperCase();
  const contract = String(form.get("contract") ?? "").trim().toUpperCase();
  const m = /^([A-Z0-9.]{1,6})(\d{2})(\d{2})(\d{2})C(\d{8})$/.exec(contract);
  const contracts = Number(form.get("contracts"));
  const premium = Number(form.get("premium"));
  const at = String(form.get("opened_at") || "");
  if (!m || !(contracts >= 1) || !(premium > 0)) throw new Error("Enter the call contract (OCC symbol), contracts and the premium per share you received.");
  await recordCallSold(ticker, contract, `20${m[2]}-${m[3]}-${m[4]}`, Number(m[5]) / 1000, Math.floor(contracts), premium, at ? nyLocalToIso(at) : new Date().toISOString());
  revalidatePath("/momentum");
}

export async function buyBackCall(form: FormData) {
  const price = Number(form.get("price"));
  if (!(price >= 0)) throw new Error("Enter the buy-back price per share.");
  await closeCall(Number(form.get("id")), "bought_back", price, new Date().toISOString());
  revalidatePath("/momentum");
}

export async function expireCall(form: FormData) {
  await closeCall(Number(form.get("id")), "expired", 0, new Date().toISOString());
  revalidatePath("/momentum");
}

export async function assignCall(form: FormData) {
  const cfg = await getMomConfig();
  await confirmAssignment(Number(form.get("id")), await loadCalendar(), cfg.fractional_shares);
  revalidatePath("/momentum");
}
