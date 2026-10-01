import "server-only";
// Morning push: every trading day, the sells to make today and why (or "no sells").
import { db } from "../db";
import { nyToday } from "../dates";
import { pushAll } from "../push";
import { loadCalendar } from "./jobs";
import { earningsWarning, formatSellPush, type SellLine } from "./notify-format";

export async function momentumMorningPush() {
  const today = nyToday();
  const cal = await loadCalendar();
  const dow = new Date(today + "T00:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6 || cal.holidays.has(today)) return { skipped: "market closed" };
  const [{ data: sells }, { count: lots }] = await Promise.all([
    db().from("ss_mom_tickets").select("ticker, shares_to_sell, exit_trigger, urgent, deadline, note")
      .eq("side", "sell").eq("status", "open").lte("trade_date", today).order("urgent", { ascending: false }).order("ticker"),
    db().from("ss_mom_lots").select("id", { count: "exact", head: true }).is("exit_date", null),
  ]);
  const { data: assigned } = await db().from("ss_mom_calls").select("ticker, contracts, strike").eq("status", "assign_pending");
  // Buy orders for today created without an earnings screen, and a data-quality block on the latest run.
  const [{ count: unchecked }, { data: run }] = await Promise.all([
    db().from("ss_mom_tickets").select("id", { count: "exact", head: true })
      .eq("side", "buy").eq("status", "open").eq("earnings_unchecked", true).lte("trade_date", today),
    db().from("ss_mom_runs").select("quality").order("signal_date", { ascending: false }).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const q = run?.quality as { gate_ok?: boolean; gate_reasons?: string[] } | null;
  const warnings = [
    earningsWarning(unchecked ?? 0),
    q && q.gate_ok === false ? `⚠ New buys blocked: ${(q.gate_reasons ?? []).join("; ")}` : null,
  ].filter((x): x is string => !!x);
  const msg = formatSellPush(today, (sells ?? []) as SellLine[], lots ?? 0, assigned ?? [], warnings);
  const sent = await pushAll(msg.title, msg.body, "/momentum");
  return { ...msg, sent };
}
