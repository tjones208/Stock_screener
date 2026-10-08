import "server-only";
// Daily scan for the pullback strategy: today's buy list for the next open, and the status of the
// trades you logged (exit list). Same rules as the backtest (lib/pullback/core.ts).
import { db, fetchAll } from "../db";
import { pushAll } from "../push";
import { addTradingDays, calendarDaysBetween, type Calendar } from "../momentum/calendar";
import { nyToday } from "../dates";
import { loadCalendar } from "../momentum/jobs";
import { entryRange, entryShares, entryStop, normalizePb, pbHistoryBars, pctRank, type PbParams } from "./core";
import { exitStatus, histOf, pbEquity, pushText, type Bars, type BuyRow, type PbSettings, type PbTrade } from "./live";

export { EXIT_LABEL, pbEquity, tradePnl, type BuyRow, type ExitStatus, type PbSettings, type PbTrade } from "./live";

export async function getPb(): Promise<PbSettings> {
  const { data } = await db().from("ss_settings").select("value").eq("key", "pullback").maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  const av = Number(v.account_value);
  return { params: normalizePb(v), account_value: Number.isFinite(av) && av > 0 ? av : null, account_set_at: (v.account_set_at as string) ?? null };
}

export async function setPb(s: PbSettings) {
  const { error } = await db().from("ss_settings").upsert({
    key: "pullback", value: { ...s.params, account_value: s.account_value, account_set_at: s.account_set_at }, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function loadTrades(): Promise<PbTrade[]> {
  const rows = await fetchAll<PbTrade>((a, b) => db().from("ss_pb_trades").select("*").order("entry_d").order("id").range(a, b));
  return rows.map((t) => ({ ...t, entry: Number(t.entry), shares: Number(t.shares), stop: Number(t.stop), target: Number(t.target), exit: t.exit == null ? null : Number(t.exit) }));
}

async function loadBars(tickers: string[], days: number, market: string) {
  const out = new Map<string, Bars>();
  for (let i = 0; i < tickers.length; i += 200) {
    const { data, error } = await db().rpc("ss_pb_bars", { p_tickers: tickers.slice(i, i + 200), p_days: days, p_market: market });
    if (error) throw new Error(`ss_pb_bars: ${error.message}`);
    for (const r of (data ?? []) as Bars[]) out.set(r.ticker, r);
  }
  return out;
}

/** Exit status of every open trade, from fresh bars (used by the page and the scan). */
export async function openTradeStatus(trades: PbTrade[], p: PbParams, cal?: Calendar) {
  const open = trades.filter((t) => !t.exit_d);
  if (!open.length) return [];
  const [bars, c] = await Promise.all([loadBars([...new Set(open.map((t) => t.ticker))], p.fast_ma + 2, p.market_ticker), cal ?? loadCalendar()]);
  return open.map((t) => exitStatus(t, bars.get(t.ticker), c, p));
}

type Universe = { ticker: string; type: string | null; n: number; c: number; c_lb: number | null; adv: number | null; ma_mid: number | null; ma_slow: number | null; flagged: boolean };

export async function runScan() {
  const [s, trades, cal] = await Promise.all([getPb(), loadTrades(), loadCalendar()]);
  const p = s.params;
  const N = pbHistoryBars(p);
  const warnings: string[] = [];
  const uni = await fetchAll<Universe>((a, b) => db().rpc("ss_pb_universe", {
    p_days: N, p_lookback: p.rs_lookback, p_dv_days: p.dollar_vol_lookback, p_mid: p.mid_ma, p_slow: p.slow_ma, p_market: p.market_ticker,
  }).range(a, b));
  const open = trades.filter((t) => !t.exit_d);
  const held = new Set(open.map((t) => t.ticker));

  // Liquid universe and relative strength (as in the backtest).
  const typeOk = (u: Universe) => !p.common_only || !u.type || u.type === "CS";
  const momOf = (u: Universe) => (u.c_lb ? u.c / u.c_lb - 1 : NaN);
  const base = uni.filter((u) => u.ticker !== p.market_ticker && typeOk(u) && Number.isFinite(momOf(u)));
  const liquid = base.filter((u) => u.c >= p.min_price && (u.adv ?? 0) >= p.min_avg_dollar_vol);
  const ranked = (p.rs_universe === "all" ? base : liquid).map(momOf).sort((a, b) => a - b);
  const rsOf = (u: Universe) => pctRank(ranked, momOf(u));
  const strong = liquid.filter((u) => rsOf(u) >= p.rs_min_percentile);
  const trend = strong.filter((u) => u.ma_mid != null && u.ma_slow != null && u.c > u.ma_mid && u.ma_mid > u.ma_slow);
  const clean = trend.filter((u) => !u.flagged && !held.has(u.ticker));

  // Full history for the remaining names: pullback, confirmation and stop from the shared rules.
  const bars = await loadBars([...new Set([...clean.map((u) => u.ticker), p.market_ticker])], N, p.market_ticker);
  const mkt = bars.get(p.market_ticker);
  if (!mkt?.d.length) throw new Error(`No bars for the market ticker ${p.market_ticker}.`);
  const d = mkt.d.at(-1)!;
  const mh = histOf(mkt, p);
  const regime = { ticker: p.market_ticker, close: mkt.c.at(-1)!, ma: Number.isFinite(mh.maSlow) ? mh.maSlow : null, ok: mkt.c.at(-1)! > mh.maSlow };
  const riskOn = !p.use_market_filter || regime.ok;

  const signals: { u: Universe; rs: number; stop: number }[] = [];
  for (const u of clean) {
    const b = bars.get(u.ticker);
    if (!b || b.d.at(-1) !== d) continue;
    const h = histOf(b, p);
    if (!(h.avgDv >= p.min_avg_dollar_vol)) continue;
    const stop = entryStop(h, b.c.at(-1)!, rsOf(u), p);
    if (stop != null) signals.push({ u, rs: rsOf(u), stop });
  }
  signals.sort((a, b) => b.rs - a.rs);

  // Sizing off the close (re-check at the fill): the Python daily_scan, with skip reasons kept.
  const equity = pbEquity(s, trades);
  if (equity == null) warnings.push("Set your account value to get share counts.");
  let heat = open.reduce((a, t) => a + t.shares * Math.max(0, t.entry - t.stop), 0);
  let count = open.length;
  const buys: BuyRow[] = [];
  for (const { u, rs, stop } of signals) {
    const ref = u.c, rps = ref - stop, stopPct = rps / ref;
    const row: BuyRow = {
      ticker: u.ticker, rs, close: ref, stop, target: ref + p.reward_risk * rps, stop_pct: stopPct,
      shares: null, risk: null, value: null, ...(() => { const r = entryRange(stop, p); return { entry_min: r.min, entry_max: r.max }; })(), skip: null,
    };
    if (rps <= 0 || stopPct < p.min_stop_pct) row.skip = `Stop too tight (${(stopPct * 100).toFixed(1)}%)`;
    else if (stopPct > p.max_stop_pct) row.skip = `Stop too wide (${(stopPct * 100).toFixed(1)}%)`;
    else if (count >= p.max_positions) row.skip = "No open slot";
    else if (equity != null) {
      const n = entryShares({ price: ref, stop, equity, openHeat: heat, openCount: count }, p);
      if (n <= 0) row.skip = "Over the open-risk (heat) cap";
      else { row.shares = n; row.risk = n * rps; row.value = n * ref; heat += n * rps; count++; }
    }
    buys.push(row);
  }

  const exits = await openTradeStatus(trades, p, cal);
  const stale = calendarDaysBetween(d, nyToday()) > 4;
  if (stale) warnings.push(`The latest bars are from ${d}: the nightly data job may be failing, so these lists are out of date.`);
  const funnel = [
    { step: `Bar on ${d}`, count: uni.length },
    { step: p.common_only ? "Common stock, enough history" : "Enough history", count: base.length },
    { step: `Close ≥ $${p.min_price}, ${p.dollar_vol_lookback}-day dollar volume ≥ $${(p.min_avg_dollar_vol / 1e6).toFixed(0)}M`, count: liquid.length },
    { step: `Relative strength ≥ ${Math.round(p.rs_min_percentile * 100)}th percentile`, count: strong.length },
    { step: `Close > ${p.mid_ma}-day > ${p.slow_ma}-day average`, count: trend.length },
    { step: "Not held, no data flags", count: clean.length },
    { step: "Pullback, then a close above the prior high", count: signals.length },
  ];
  const trade_d = addTradingDays(cal, d, 1);
  const scan = { signal_d: d, trade_d, equity, regime: { ...regime, filter: p.use_market_filter }, funnel, buys: riskOn ? buys : [], exits, warnings: riskOn ? warnings : [...warnings, `${p.market_ticker} is under its ${p.slow_ma}-day average: no new buys.`], created_at: new Date().toISOString() };
  const { error } = await db().from("ss_pb_scans").upsert(scan, { onConflict: "signal_d" });
  if (error) throw new Error(`ss_pb_scans: ${error.message}`);
  return { ...scan, riskOn, stale, blockedBuys: riskOn ? 0 : buys.length };
}

/** Cron: scan the latest close, push once per signal day when there are buys or exits. */
export async function pullbackJob() {
  const r = await runScan();
  const { data: row } = await db().from("ss_pb_scans").select("notified_at").eq("signal_d", r.signal_d).maybeSingle();
  const msg = pushText(r);
  let sent: number | null = null;
  if (msg && !row?.notified_at && !r.stale) {
    sent = await pushAll(msg.title, msg.body, "/pullback");
    await db().from("ss_pb_scans").update({ notified_at: new Date().toISOString() }).eq("signal_d", r.signal_d);
  }
  return {
    signal_d: r.signal_d, trade_d: r.trade_d, riskOn: r.riskOn, buys: r.buys.filter((b) => b.shares).length, listed: r.buys.length,
    exits: r.exits.filter((x) => x.action === "EXIT").length, open: r.exits.length, funnel: r.funnel, push: msg?.title ?? null, sent, warnings: r.warnings,
  };
}

