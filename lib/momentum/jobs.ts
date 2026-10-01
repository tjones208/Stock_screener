import "server-only";
// Momentum strategy jobs: data upkeep (splits, holidays, news), validation and the ranking build.
import { db, fetchAll, upsertChunks } from "../db";
import { dailyRange, newsForDay, splitsSince, upcomingHolidays } from "../massive";
import { addDays, nyToday } from "../dates";
import { LONG_HISTORY_DAYS, REGIME_TICKER } from "../jobs";
import { capitalAndSlots, normalizeMomConfig, type MomConfig } from "./config";
import { isMonthEnd, isWeekEnd, nextTradingDay, type Calendar } from "./calendar";
import { advanceTickets, createTickets } from "./tickets";
import { exitReview, updateStops } from "./positions";
import { refreshCallIdeas, settleExpiredCalls } from "./covered";
import { tickerSectors } from "./sector-db";
import { regimeAt, type Regime } from "./regime";
import { buyoutHits } from "./news";

const NEWS_DAYS = 90;

export async function getMomConfig(): Promise<MomConfig> {
  const { data } = await db().from("ss_settings").select("value").eq("key", "momentum").maybeSingle();
  return normalizeMomConfig(data?.value as Record<string, unknown> | undefined);
}

export async function setMomConfig(c: MomConfig) {
  const { error } = await db().from("ss_settings").upsert({ key: "momentum", value: c, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function loadCalendar(): Promise<Calendar> {
  const [days, hol] = await Promise.all([
    fetchAll<{ d: string }>((a, b) => db().from("ss_loaded_days").select("d").gt("rows", 0).order("d").range(a, b)),
    db().from("ss_market_holidays").select("d, status"),
  ]);
  return {
    traded: days.map((r) => r.d),
    holidays: new Set((hol.data ?? []).filter((h) => h.status === "closed").map((h) => h.d as string)),
  };
}

/** Latest trading day with bars loaded. */
export async function latestTradingDay(): Promise<string | null> {
  const { data } = await db().from("ss_loaded_days").select("d").gt("rows", 0).order("d", { ascending: false }).limit(1);
  return (data?.[0]?.d as string | undefined) ?? null;
}

export async function syncHolidays() {
  const rows = (await upcomingHolidays())
    .filter((h) => h.exchange === "NYSE")
    .map((h) => ({ d: h.date, name: h.name, status: h.status }));
  if (rows.length) await upsertChunks("ss_market_holidays", rows, "d");
  return rows.length;
}

/**
 * Pull splits since the last one on record (or the whole history window), then mark the ones whose
 * pre-split bars were stored before the split happened: those bars are unadjusted and need a re-fetch.
 */
export async function syncSplits() {
  const { data: last } = await db().from("ss_splits").select("execution_date").order("execution_date", { ascending: false }).limit(1);
  const today = nyToday();
  const from = last?.[0] ? addDays(last[0].execution_date as string, -7) : addDays(today, -LONG_HISTORY_DAYS);
  const splits = (await splitsSince(from)).filter((s) => s.execution_date <= today && s.split_from > 0 && s.split_to > 0);
  const rows = splits.map((s) => ({ ticker: s.ticker, execution_date: s.execution_date, split_from: s.split_from, split_to: s.split_to }));
  // ignoreDuplicates keeps repaired_at on splits we already handled.
  if (rows.length) await upsertChunks("ss_splits", rows, "ticker,execution_date", 1000, true);
  const { data: marked, error } = await db().rpc("ss_mark_split_repairs");
  if (error) throw new Error(`ss_mark_split_repairs: ${error.message}`);
  return { fetched: rows.length, needRepair: marked as number };
}

/** Re-fetch full split-adjusted history for tickers with unrepaired splits (liquid names first). */
export async function repairSplits(left: () => number) {
  const { data: todo, error } = await db().rpc("ss_split_repair_queue");
  if (error) throw new Error(`ss_split_repair_queue: ${error.message}`);
  const done: string[] = [];
  for (const t of (todo ?? []) as { ticker: string; first_d: string }[]) {
    if (left() < 25_000) break;
    const bars = await dailyRange(t.ticker, t.first_d, nyToday());
    const rows = bars.filter((b) => b.d >= t.first_d).map((b) => ({
      ticker: t.ticker, d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: Math.round(b.v), vw: b.vw ?? null, n: b.n ?? null,
    }));
    if (rows.length) await upsertChunks("ss_daily_bars", rows, "ticker,d");
    await db().from("ss_splits").update({ repaired_at: new Date().toISOString() })
      .eq("ticker", t.ticker).eq("needs_repair", true).is("repaired_at", null);
    done.push(t.ticker);
  }
  return { repaired: done.length, remaining: ((todo ?? []) as unknown[]).length - done.length, tickers: done.slice(0, 20) };
}

/**
 * Market-wide news sweep for acquisition headlines, one UTC day at a time (newest missing day first),
 * covering the last 90 calendar days. Hits become buyout_news (excluded) or buyout_review flags.
 */
export async function newsSweep(left: () => number) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: have } = await db().from("ss_news_days").select("d").gte("d", addDays(today, -NEWS_DAYS));
  const got = new Set((have ?? []).map((r) => r.d as string));
  const missing: string[] = [];
  for (let i = 1; i <= NEWS_DAYS; i++) {
    const d = addDays(today, -i);
    if (!got.has(d)) missing.push(d);
  }
  if (!missing.length) return { days: 0, remaining: 0 };
  const names = new Map(
    (await fetchAll<{ ticker: string; name: string | null }>((a, b) =>
      db().from("ss_tickers").select("ticker, name").eq("type", "CS").eq("active", true).range(a, b)))
      .map((t) => [t.ticker, t.name ?? ""]),
  );
  let days = 0, matches = 0;
  for (const d of missing) {
    if (left() < 60_000) break; // a busy day can take several pages
    const articles = await newsForDay(d, addDays(d, 1));
    const hits = articles.flatMap((a) =>
      buyoutHits({ title: a.title ?? "", tickers: a.tickers ?? [], published: a.published_utc, url: a.article_url }, names));
    const flags = [...new Map(hits.map((h) => [`${h.ticker}|${h.kind}|${h.d}`, h])).values()].map((h) => ({
      ticker: h.ticker, kind: h.kind, d: h.d, detail: h.detail, excludes: h.kind === "buyout_news",
    }));
    if (flags.length) await upsertChunks("ss_data_flags", flags, "ticker,kind,d", 1000, true);
    await db().from("ss_news_days").upsert({ d, articles: articles.length, matches: flags.length, fetched_at: new Date().toISOString() });
    days++;
    matches += flags.length;
  }
  return { days, matches, remaining: missing.length - days };
}

async function spyBars(t: string) {
  return fetchAll<{ d: string; c: number }>((a, b) =>
    db().from("ss_daily_bars").select("d, c").eq("ticker", REGIME_TICKER).lte("d", t).order("d").range(a, b));
}

export type MomRunKind = "daily" | "weekly" | "monthly";

/** Validation + universe + signals + ranking snapshot for the latest trading day, plus the regime. */
export async function momentumBuild(t?: string) {
  const [cfg, cal, latest] = await Promise.all([getMomConfig(), loadCalendar(), t ? Promise.resolve(t) : latestTradingDay()]);
  if (!latest) return { skipped: "no data" };
  const kind: MomRunKind = isMonthEnd(cal, latest) ? "monthly" : isWeekEnd(cal, latest) ? "weekly" : "daily";
  const { N } = capitalAndSlots(cfg);
  const { data, error } = await db().rpc("ss_mom_build", { p_t: latest, p_kind: kind, p_cfg: cfg, p_n: N });
  if (error) throw new Error(`ss_mom_build: ${error.message}`);
  const sectors = await storeSnapshotSectors(latest);
  const regime: Regime = regimeAt(await spyBars(latest), latest, cal, cfg.regime_sma_months);
  await db().from("ss_mom_runs").update({ regime }).eq("signal_date", latest).eq("kind", kind);
  // Tickets work the next session: roll unfilled ones forward first, then add this plan's buys.
  // Weekly refills use the regime as of the last month-end (it isn't re-checked weekly).
  // Order: stops on today's close → exit review (sells first) → roll open buys → new buys for freed slots.
  const tradeDay = nextTradingDay(cal, latest);
  const stops = await updateStops(latest, cfg);
  const calls = await settleExpiredCalls(latest);
  const exits = await exitReview(latest, kind === "monthly", regime.riskOn, cfg, tradeDay, cal);
  const advanced = await advanceTickets(latest, tradeDay, cfg, cal);
  const tickets = kind === "daily" ? null : await createTickets(latest, kind, cfg, regime.riskOn, tradeDay, cal);
  // Covered-call suggestions for the session (after exits, so positions being sold are skipped).
  const callIdeas = await refreshCallIdeas(tradeDay, cfg, cal).catch((e) => ({ error: String(e) }));
  return { signalDate: latest, kind, N, tradeDay, regime: { riskOn: regime.riskOn, close: regime.close, sma: regime.sma }, stops, calls, exits, advanced, tickets, callIdeas, sectors, ...(data as object) };
}

/** Record the GICS sector bucket (momSector) on each snapshot row of signal date t; sic2 stays for reference. */
async function storeSnapshotSectors(t: string) {
  const rows = await fetchAll<{ ticker: string }>((a, b) => db().from("ss_mom_snapshots").select("ticker").eq("signal_date", t).range(a, b));
  const sectors = await tickerSectors(rows.map((r) => r.ticker));
  // Only the sector column is sent, so the upsert leaves every other column as the build wrote it.
  await upsertChunks("ss_mom_snapshots", rows.map((r) => ({ signal_date: t, ticker: r.ticker, sector: sectors.get(r.ticker) })), "signal_date,ticker");
  const counts: Record<string, number> = {};
  for (const v of sectors.values()) { const k = v.startsWith("unknown:") ? "unknown" : v; counts[k] = (counts[k] ?? 0) + 1; }
  return counts;
}
