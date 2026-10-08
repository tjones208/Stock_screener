"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { nyToday } from "@/lib/dates";
import { normalizePb, PB_DEFAULTS } from "@/lib/pullback/core";
import { getPb, runScan, setPb } from "@/lib/pullback/scan";

const numOf = (form: FormData, k: string) => {
  const v = Number(String(form.get(k) ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : NaN;
};
const dateOf = (form: FormData, k: string) => {
  const v = String(form.get(k) ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : nyToday();
};

export async function savePbSettings(form: FormData) {
  const s = await getPb();
  const input: Record<string, unknown> = { ...s.params };
  for (const [k, dflt] of Object.entries(PB_DEFAULTS)) {
    if (typeof dflt === "boolean") input[k] = form.get(k) === "on";
    else if (form.has(k)) input[k] = form.get(k);
  }
  await setPb({ ...s, params: normalizePb(input) });
  revalidatePath("/pullback");
}

/** Account value for sizing; P&L from trades closed after today is added on top. */
export async function saveAccountValue(form: FormData) {
  const s = await getPb();
  const v = numOf(form, "account_value");
  await setPb({ ...s, account_value: v > 0 ? v : null, account_set_at: v > 0 ? nyToday() : null });
  revalidatePath("/pullback");
}

export async function runScanNow() {
  await runScan();
  revalidatePath("/pullback");
}

/** Log a buy: your fill and shares; the stop is the signal's, the target is re-set from the fill. */
export async function logBuy(form: FormData) {
  const s = await getPb();
  const ticker = String(form.get("ticker") ?? "").trim().toUpperCase();
  const entry = numOf(form, "entry"), shares = numOf(form, "shares"), stop = numOf(form, "stop");
  if (!ticker || !(entry > 0) || !(shares > 0) || !(stop > 0)) throw new Error("Enter the ticker, your fill price, shares and a stop.");
  if (stop >= entry) throw new Error(`The stop (${stop}) must be under the fill (${entry}).`);
  const t = numOf(form, "target");
  const target = t > entry ? t : entry + s.params.reward_risk * (entry - stop);
  const { error } = await db().from("ss_pb_trades").insert({
    ticker, entry, shares, stop, target, entry_d: dateOf(form, "entry_d"),
    signal_d: String(form.get("signal_d") ?? "") || null, note: String(form.get("note") ?? "") || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/pullback");
}

export async function logSell(form: FormData) {
  const id = Number(form.get("id")), exit = numOf(form, "exit");
  if (!(exit > 0)) throw new Error("Enter your sale price.");
  const { error } = await db().from("ss_pb_trades").update({
    exit, exit_d: dateOf(form, "exit_d"), exit_reason: String(form.get("reason") ?? "manual") || "manual", updated_at: new Date().toISOString(),
  }).eq("id", id).is("exit_d", null);
  if (error) throw new Error(error.message);
  revalidatePath("/pullback");
}

/** Move the stop or target of an open trade. */
export async function editLevels(form: FormData) {
  const id = Number(form.get("id")), stop = numOf(form, "stop"), target = numOf(form, "target");
  const patch: Record<string, number | string> = { updated_at: new Date().toISOString() };
  if (stop > 0) patch.stop = stop;
  if (target > 0) patch.target = target;
  const { error } = await db().from("ss_pb_trades").update(patch).eq("id", id).is("exit_d", null);
  if (error) throw new Error(error.message);
  revalidatePath("/pullback");
}

/** Undo: an open trade is deleted; a closed trade is reopened. */
export async function undoTrade(form: FormData) {
  const id = Number(form.get("id"));
  const { data } = await db().from("ss_pb_trades").select("exit_d").eq("id", id).maybeSingle();
  const { error } = data?.exit_d
    ? await db().from("ss_pb_trades").update({ exit: null, exit_d: null, exit_reason: null, updated_at: new Date().toISOString() }).eq("id", id)
    : await db().from("ss_pb_trades").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/pullback");
}
