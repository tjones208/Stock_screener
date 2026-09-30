import "server-only";
// Morning push: every trading day, the sells to make today and why (or "no sells").
import { db } from "../db";
import { nyToday } from "../dates";
import { pushAll } from "../push";
import { loadCalendar } from "./jobs";
import { formatSellPush, type SellLine } from "./notify-format";

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
  const msg = formatSellPush(today, (sells ?? []) as SellLine[], lots ?? 0);
  const sent = await pushAll(msg.title, msg.body, "/momentum");
  return { ...msg, sent };
}
