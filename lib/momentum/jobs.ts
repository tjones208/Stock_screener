import "server-only";
// Momentum strategy jobs: data upkeep (splits, holidays, news), validation and the ranking build.
import { db, fetchAll, upsertChunks } from "../db";
import { dailyRange, newsForDay, splitsSince, upcomingHolidays } from "../massive";
import { addDays, nyToday } from "../dates";
import { LONG_HISTORY_DAYS, REGIME_TICKER } from "../jobs";
import { capitalAndSlots, normalizeMomConfig, type MomConfig } from "./config";
import { isMonthEnd, isWeekEnd, nextTradingDay, type Calendar } from "./calendar";
import { advanceTickets, createTickets, earningsWithin, occupied, ownedOrSelling } from "./tickets";
import { closedLots, exitReview, openLots, updateStops } from "./positions";
import { planPortfolio, type Candidate } from "./sizing";
import { tickerSectors, withSectors } from "./sector-db";
import { sectorLabel } from "./sector-key";
import { volScale, washBlocked } from "./risk";
import { ltWindow } from "./stops";
import { writeEquity } from "./equity";
import { refreshCallIdeas, settleExpiredCalls } from "./covered";
import { dataGate, passedMcapCheck, type RunQuality } from "./quality";
import { earningsStatus } from "../earnings-sync";
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

/** Regime state stored at the month-end before `monthEnd` (null when there is no such run). */
async function priorRegime(monthEnd: string | null): Promise<boolean | null> {
  if (!monthEnd) return null;
  const { data } = await db().from("ss_mom_runs").select("signal_date, regime").eq("kind", "monthly").lt("signal_date", monthEnd)
    .order("signal_date", { ascending: false }).limit(1);
  const r = data?.[0]?.regime as { riskOn?: boolean | null } | undefined;
  return r?.riskOn ?? null;
}

/** Regime with the band (prior month-end state) and the volatility brake m, both as of t. */
async function marketState(t: string, cal: Calendar, cfg: MomConfig) {
  const bars = await spyBars(t);
  const plain = regimeAt(bars, t, cal, cfg.regime_sma_months);
  const prior = await priorRegime(plain.monthEnd);
  const regime: Regime = regimeAt(bars, t, cal, cfg.regime_sma_months, cfg.regime_band_pct, prior);
  const vs = volScale(bars.map((b) => b.c), cfg);
  return { regime, m: vs.m, spyVol: vs.vol };
}

async function heldTickers(): Promise<string[]> {
  const { data } = await db().from("ss_mom_lots").select("ticker").is("exit_date", null);
  return [...new Set((data ?? []).map((l) => l.ticker as string))];
}

/** Validation + universe + signals + ranking snapshot for the latest trading day, plus the regime. */
export async function momentumBuild(t?: string) {
  const [cfg, cal, latest] = await Promise.all([getMomConfig(), loadCalendar(), t ? Promise.resolve(t) : latestTradingDay()]);
  if (!latest) return { skipped: "no data" };
  const kind: MomRunKind = isMonthEnd(cal, latest) ? "monthly" : isWeekEnd(cal, latest) ? "weekly" : "daily";
  const { N } = capitalAndSlots(cfg);
  // Held tickers always get a snapshot row, even outside the universe.
  const { data, error } = await db().rpc("ss_mom_build", { p_t: latest, p_kind: kind, p_cfg: cfg, p_n: N, p_held: await heldTickers(), p_dry: false });
  if (error) throw new Error(`ss_mom_build: ${error.message}`);
  const sectors = await storeSnapshotSectors(latest);
  const { regime, m, spyVol } = await marketState(latest, cal, cfg);
  // Buy safety: data-quality gate (no new buy tickets) and earnings check (tickets flagged).
  const built = data as { funnel: { count: number }[]; warnings: string[]; universe: number; hold_cutoff: number; hold_cutoff_classic: number };
  const { gate, quality, earnings } = await buySafety(latest, built, cfg);
  const warnings = [
    ...(built.warnings ?? []),
    ...gate.reasons.map((r) => `New buys blocked: ${r}`),
    ...(earnings.ok ? [] : [`Earnings unchecked: ${earnings.reason} Buy tickets are created but not screened for earnings in the next ${cfg.earnings_blackout_days} trading days.`]),
  ];
  const stored = { ...regime, volScale: m, spyVol, holdCutoff: built.hold_cutoff, universe: built.universe };
  await db().from("ss_mom_runs").update({ regime: stored, quality, warnings }).eq("signal_date", latest).eq("kind", kind);
  // Tickets work the next session: roll unfilled ones forward first, then add this plan's buys.
  // Weekly refills use the regime as of the last month-end (it isn't re-checked weekly).
  // Order: stops on today's close → exit review (sells first) → roll open buys → new buys for freed slots.
  const tradeDay = nextTradingDay(cal, latest);
  const stops = await updateStops(latest, cfg);
  const calls = await settleExpiredCalls(latest);
  const unchecked = !earnings.ok;
  const wash = washBlocked(await closedLots(), latest, cfg.wash_sale_block_days);
  const buyOpts = { earningsUnchecked: unchecked, m, washBlocked: wash };
  const exits = await exitReview(latest, kind, regime.riskOn, cfg, tradeDay, cal, { ...buyOpts, allowTopups: gate.ok });
  const advanced = await advanceTickets(latest, tradeDay, cfg, cal, { ...buyOpts, allowNewBuys: gate.ok });
  const tickets = kind === "daily" ? null
    : !gate.ok ? { created: 0, blocked: gate.reasons }
    : await createTickets(latest, kind, cfg, regime.riskOn, tradeDay, cal, buyOpts);
  // Covered-call suggestions for the session (after exits, so positions being sold are skipped).
  const callIdeas = await refreshCallIdeas(tradeDay, cfg, cal).catch((e) => ({ error: String(e) }));
  const equity = await writeEquity(latest, cfg, m).catch((e) => ({ error: String(e) }));
  return {
    signalDate: latest, kind, N, tradeDay, regime: { riskOn: regime.riskOn, prior: regime.prior, close: regime.close, sma: regime.sma },
    m, spyVol, holdCutoff: built.hold_cutoff, stops, calls, exits, advanced, tickets, callIdeas, equity, sectors,
    funnel: built.funnel, warnings, quality, washBlocked: Object.fromEntries(wash),
  };
}

type DryRow = Candidate & {
  mom: number; mom_pct: number; h52: number; h52_pct: number; days_since_high: number; sigma252: number | null;
  composite: number; composite_classic: number; composite_risk_adj: number; hold_ok: boolean; hold_reason: string | null;
  entry_reason: string | null; held_outside_universe: boolean;
};

/**
 * Dry run: the build and plan for signal date t with the current code and settings, writing nothing
 * (no flags, snapshots, run row, tickets or lots). Compares with the stored plan for t.
 */
export async function momentumDryRun(t: string) {
  const [cfg, cal] = await Promise.all([getMomConfig(), loadCalendar()]);
  const kind: MomRunKind = isMonthEnd(cal, t) ? "monthly" : isWeekEnd(cal, t) ? "weekly" : "daily";
  const { N } = capitalAndSlots(cfg);
  const { data, error } = await db().rpc("ss_mom_build", { p_t: t, p_kind: kind, p_cfg: cfg, p_n: N, p_held: await heldTickers(), p_dry: true });
  if (error) throw new Error(`ss_mom_build (dry): ${error.message}`);
  const built = data as { rows: Omit<DryRow, "sector">[]; universe: number; hold_cutoff: number; hold_cutoff_classic: number; funnel: unknown };
  const rows = (await withSectors((built.rows ?? []).map((r) => ({ ...r, sigma63: (r as unknown as { sigma63: number }).sigma63 })))) as DryRow[];
  const { regime, m, spyVol } = await marketState(t, cal, cfg);
  const wash = washBlocked(await closedLots(), t, cfg.wash_sale_block_days);
  const [held, earnings, busy] = await Promise.all([occupied({ signal_date: t, kind }), earningsWithin(cal, t, cfg), ownedOrSelling()]);
  const plan = planPortfolio({ cfg, candidates: rows.filter((r) => !busy.has(r.ticker)), held, riskOn: regime.riskOn, earnings,
    washBlocked: new Set(wash.keys()), scale: m });
  const top = (key: "composite_classic" | "composite_risk_adj") => [...rows].filter((r) => !r.held_outside_universe)
    .sort((a, b) => b[key] - a[key] || b.mom - a.mom).slice(0, 25)
    .map((r, i) => ({ rank: i + 1, ticker: r.ticker, sector: sectorLabel(r.sector ?? ""), composite: Math.round(r[key] * 10) / 10, mom: Math.round(r.mom * 1000) / 10, entry_ok: r.entry_ok }));
  const [{ data: oldTix }, { data: oldRun }, lotsNow] = await Promise.all([
    db().from("ss_mom_tickets").select("ticker, status, sector, comp_rank, t_target, planned_shares, cap, alt_order").eq("signal_date", t).eq("kind", kind).eq("side", "buy").order("comp_rank"),
    db().from("ss_mom_runs").select("regime, n").eq("signal_date", t).eq("kind", kind).maybeSingle(),
    openLots(),
  ]);
  const oldRegime = oldRun?.regime as (Regime & { volScale?: number; holdCutoff?: number }) | null;
  const ltWindowLots = lotsNow.filter((l) => {
    const c = rows.find((r) => r.ticker === l.ticker)?.close;
    return c != null && ltWindow(l, c, t, cfg);
  }).map((l) => ({ ticker: l.ticker, lt_date: l.lt_date }));
  return {
    signalDate: t, kind, N,
    old: {
      buys: (oldTix ?? []).filter((x) => x.status !== "alternate").map((x) => ({ ticker: x.ticker, sector: sectorLabel(x.sector ?? ""), comp_rank: x.comp_rank, amount: Math.round((x.planned_shares ?? 0) * (x.cap ?? 0)), status: x.status })),
      alternates: (oldTix ?? []).filter((x) => x.status === "alternate").map((x) => x.ticker),
      holdCutoff: oldRegime?.holdCutoff ?? 2 * (oldRun?.n ?? N), m: oldRegime?.volScale ?? 1,
      regime: oldRegime ? { riskOn: oldRegime.riskOn, close: oldRegime.close, sma: oldRegime.sma } : null,
    },
    new: {
      buys: plan.buys.map((b) => ({ ticker: b.ticker, sector: sectorLabel(b.sector), comp_rank: b.comp_rank, shares: b.shares, amount: Math.round(b.amount), T: Math.round(b.T) })),
      alternates: plan.alternates.map((a) => a.ticker),
      skipped: plan.skipped, message: plan.message ?? null,
      holdCutoff: built.hold_cutoff, holdCutoffClassic: built.hold_cutoff_classic, universe: built.universe,
      m, spyVol, regime: { riskOn: regime.riskOn, prior: regime.prior, band: regime.band, close: regime.close, sma: regime.sma, monthEnd: regime.monthEnd },
      washBlocked: Object.fromEntries(wash), ltWindowLots, openLots: lotsNow.length,
    },
    topClassic: top("composite_classic"), topRiskAdj: top("composite_risk_adj"),
  };
}

/**
 * Data-quality inputs for this run, the gate against the previous run that passed the market-cap
 * check (see quality.dataGate), and whether the earnings calendar is usable.
 */
async function buySafety(t: string, built: { funnel: { count: number }[] }, cfg: MomConfig) {
  const [{ data: q, error }, { data: prevRows }, earnings] = await Promise.all([
    db().rpc("ss_mom_quality", { p_t: t, p_min_price: cfg.min_price, p_min_dv: cfg.min_median_dollar_vol_60d }),
    db().from("ss_mom_runs").select("signal_date, quality").lt("signal_date", t).not("quality", "is", null)
      .order("signal_date", { ascending: false }).order("created_at", { ascending: false }).limit(10),
    earningsStatus(),
  ]);
  if (error) throw new Error(`ss_mom_quality: ${error.message}`);
  const cur: RunQuality = { universe: built.funnel?.at(-1)?.count ?? 0, no_mcap: (q as RunQuality).no_mcap, news_days: (q as RunQuality).news_days };
  // Baseline = the most recent earlier run that passed the market-cap check.
  const prev = ((prevRows ?? []) as { signal_date: string; quality: RunQuality }[]).find((r) => passedMcapCheck(r.quality, cfg)) ?? null;
  const gate = dataGate(cur, prev, cfg);
  const quality = { ...cur, gate_ok: gate.ok, gate_reasons: gate.reasons, compared_to: gate.comparedTo,
    earnings_ok: earnings.ok, earnings_reason: earnings.reason, earnings_future_rows: earnings.futureRows };
  return { gate, quality, earnings };
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
