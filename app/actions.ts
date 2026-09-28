"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { cleanFilters } from "@/lib/screen";
import { ALERT_KINDS, type AlertKind } from "@/lib/alerts";
import { setSizing } from "@/lib/settings";
import { normalizeSizing } from "@/lib/sizing";

const T = (s: FormDataEntryValue | null) => String(s ?? "").trim().toUpperCase();

export async function createWatchlist(form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  if (name) await db().from("ss_watchlists").insert({ name });
  revalidatePath("/watchlists");
}

export async function deleteWatchlist(form: FormData) {
  await db().from("ss_watchlists").delete().eq("id", Number(form.get("id")));
  revalidatePath("/watchlists");
}

export async function addToWatchlist(form: FormData) {
  const ticker = T(form.get("ticker"));
  const id = Number(form.get("watchlist_id"));
  if (ticker && id) await db().from("ss_watchlist_items").upsert({ watchlist_id: id, ticker });
  revalidatePath("/");
  revalidatePath("/watchlists");
  revalidatePath(`/t/${ticker}`);
}

export async function removeFromWatchlist(form: FormData) {
  const ticker = T(form.get("ticker"));
  await db().from("ss_watchlist_items").delete().eq("watchlist_id", Number(form.get("watchlist_id"))).eq("ticker", ticker);
  revalidatePath("/");
  revalidatePath("/watchlists");
  revalidatePath(`/t/${ticker}`);
}

export async function saveScreen(form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  const qs = String(form.get("qs") ?? "");
  if (!name) return;
  const filters = cleanFilters(Object.fromEntries(new URLSearchParams(qs)));
  await db().from("ss_screens").upsert({ name, filters, updated_at: new Date().toISOString() }, { onConflict: "name" });
  revalidatePath("/");
}

export async function deleteScreen(form: FormData) {
  await db().from("ss_screens").delete().eq("id", Number(form.get("id")));
  revalidatePath("/");
  redirect("/");
}

export async function createAlert(form: FormData) {
  const kind = String(form.get("kind")) as AlertKind;
  if (!(kind in ALERT_KINDS)) return;
  const def = ALERT_KINDS[kind];
  const params: Record<string, number> = {};
  if (def.param) {
    const v = Number(form.get("value"));
    if (!Number.isFinite(v)) return;
    params[def.param] = v;
  }
  const scope = String(form.get("scope") ?? "");
  const ticker = T(form.get("ticker")) || null;
  const row = {
    name: String(form.get("name") || "").trim() || `${def.label}${def.param ? ` ${params[def.param]}` : ""}${ticker ? ` · ${ticker}` : ""}`,
    kind,
    params,
    ticker: scope === "ticker" ? ticker : null,
    watchlist_id: scope.startsWith("w:") ? Number(scope.slice(2)) : null,
    screen_id: scope.startsWith("s:") ? Number(scope.slice(2)) : null,
  };
  if (scope === "ticker" && !row.ticker) return;
  await db().from("ss_alert_rules").insert(row);
  revalidatePath("/alerts");
}

export async function toggleAlert(form: FormData) {
  await db().from("ss_alert_rules").update({ enabled: form.get("enabled") === "1" }).eq("id", Number(form.get("id")));
  revalidatePath("/alerts");
}

export async function deleteAlert(form: FormData) {
  await db().from("ss_alert_rules").delete().eq("id", Number(form.get("id")));
  revalidatePath("/alerts");
}

export async function saveSizing(form: FormData) {
  const pctOrNum = (k: string) => String(form.get(k) ?? "").replace(/[$,%\s]/g, "");
  await setSizing(normalizeSizing({
    account: pctOrNum("account"),
    riskPct: pctOrNum("riskPct"),
    dayTradeLeverage: pctOrNum("dayTradeLeverage"),
    overnightLeverage: pctOrNum("overnightLeverage"),
    maxAdvPct: pctOrNum("maxAdvPct"),
    wheelAllocation: pctOrNum("wheelAllocation"),
  }));
  revalidatePath("/");
}

/** Star/unstar a ticker from the screener: adds it to the list, or removes it if already there. */
export async function toggleWatchlist(form: FormData) {
  const ticker = T(form.get("ticker"));
  const id = Number(form.get("watchlist_id"));
  if (!ticker || !id) return;
  const { data } = await db().from("ss_watchlist_items").select("ticker").eq("watchlist_id", id).eq("ticker", ticker).maybeSingle();
  if (data) await db().from("ss_watchlist_items").delete().eq("watchlist_id", id).eq("ticker", ticker);
  else await db().from("ss_watchlist_items").insert({ watchlist_id: id, ticker });
  revalidatePath("/");
  revalidatePath("/watchlists");
  revalidatePath(`/t/${ticker}`);
}
