"use server";
import { revalidatePath } from "next/cache";
import { db, upsertChunks } from "@/lib/db";
import { MOM_DEFAULTS, normalizeMomConfig, type MomKey } from "@/lib/momentum/config";
import { getMomConfig, setMomConfig } from "@/lib/momentum/jobs";

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
