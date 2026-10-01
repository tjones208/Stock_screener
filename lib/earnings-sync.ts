import "server-only";
// Nightly earnings calendar from Finnhub → ss_earnings_calendar (CSV uploads are kept alongside).
import { db, upsertChunks } from "./db";
import { addDays, nyToday } from "./dates";
import { earningsCalendar, finnhubReady } from "./finnhub";
import { dateWindows, parseFinnhub } from "./earnings";
import { earningsChecked } from "./momentum/quality";

/** Days ahead the calendar covers; a stock with no date inside it has no earnings scheduled that soon. */
export const EARNINGS_HORIZON_DAYS = 91;

export async function syncEarnings() {
  try {
    const r = await syncEarningsInner();
    await db().from("ss_settings").delete().eq("key", "earnings_sync_error");
    return r;
  } catch (e) {
    // Recorded so the build, tickets, page and push all see the same "earnings unchecked" status.
    await db().from("ss_settings").upsert({ key: "earnings_sync_error", value: { error: String(e).slice(0, 300), at: new Date().toISOString() }, updated_at: new Date().toISOString() });
    throw e;
  }
}

/** Whether buy tickets can rely on the earnings calendar right now (see quality.earningsChecked). */
export async function earningsStatus() {
  const [{ count }, { data: err }] = await Promise.all([
    db().from("ss_earnings_calendar").select("ticker", { count: "exact", head: true }).gte("report_date", nyToday()),
    db().from("ss_settings").select("value").eq("key", "earnings_sync_error").maybeSingle(),
  ]);
  const e = err?.value as { error?: string } | undefined;
  return { futureRows: count ?? 0, ...earningsChecked(count ?? 0, e?.error ?? null) };
}

async function syncEarningsInner() {
  if (!finnhubReady()) return { skipped: "FINNHUB_API_KEY not set" };
  const today = nyToday();
  const from = addDays(today, -7);
  const to = addDays(today, EARNINGS_HORIZON_DAYS);
  const rows = [];
  for (const [a, b] of dateWindows(from, to, 7)) rows.push(...parseFinnhub(await earningsCalendar(a, b)));
  // Replace Finnhub's rows in the window so rescheduled dates don't linger.
  const { error } = await db().from("ss_earnings_calendar").delete().eq("source", "finnhub").gte("report_date", from).lte("report_date", to);
  if (error) throw new Error(`ss_earnings_calendar: ${error.message}`);
  await upsertChunks("ss_earnings_calendar", rows.map((r) => ({ ...r, uploaded_at: new Date().toISOString() })), "ticker,report_date");
  await db().from("ss_settings").upsert({ key: "earnings_sync", value: { from, to, rows: rows.length, synced_at: new Date().toISOString() }, updated_at: new Date().toISOString() });
  // Open momentum positions: next report on or after today.
  const { data: lots } = await db().from("ss_mom_lots").select("id, ticker").is("exit_date", null);
  let lotsUpdated = 0;
  for (const l of lots ?? []) {
    const { data: next } = await db().from("ss_earnings_calendar").select("report_date").eq("ticker", l.ticker).gte("report_date", today).order("report_date").limit(1);
    await db().from("ss_mom_lots").update({ earnings_date: next?.[0]?.report_date ?? null }).eq("id", l.id);
    lotsUpdated++;
  }
  return { rows: rows.length, from, to, lotsUpdated };
}
