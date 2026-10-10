// Earnings drift study: after an earnings release (an 8-K with item 2.02, from bt fetch-earnings),
// do the biggest positive reactions keep drifting up, and the biggest negative ones keep drifting down?
//
// Per event (ticker, filing date F): reaction = close on the first session after F ÷ close on the last
// session before F − 1 (covers releases before the open and after the close). Events count when, on
// that reaction day, the close is over `min_price` and the stock passes the liquidity filter (20-day
// average dollar volume, common stock). Entry: the open of the next session (two sessions after a
// trading-day filing). Returns: entry open → close of session N counting the entry day; a stock that
// stops trading counts at its last close; split-adjusted, no dividends.
//
// Groups, by the year of the reaction day:
//   signal (top)  — reaction in the top `top_pct` of events ranked within its window
//   bottom        — reaction in the bottom `bottom_pct` (does the drift run both ways?)
//   all events    — baseline A: every event
//   universe      — baseline B: every liquid stock entering on the signal's entry days
// Ranking window: "quarter" ranks against every event of the same calendar quarter (as specified — this
// uses reactions later in the quarter, so it isn't tradable as is); "trailing" ranks against the events
// of the previous `trailing_days` sessions only (no look-ahead).
import type { DataSource } from "./engine/engine.ts";
import type { Row } from "./engine/types.ts";
import { pctRank } from "../../lib/pullback/core.ts";
import type { StudyResult, StudyRow } from "./study.ts";

export type EarningsSpec = {
  name?: string; from?: string; to?: string; horizons?: number[]; cost?: number;
  top_pct?: number; bottom_pct?: number; rank_window?: "quarter" | "trailing"; trailing_days?: number; min_trailing_events?: number;
  min_price?: number; min_avg_dollar_vol?: number; dollar_vol_lookback?: number; common_only?: boolean;
};

type Ev = { ticker: string; f: string; i0: number; i1: number; c0?: number; react?: number; year: string; quarter: string;
  entry?: number; r: (number | null)[]; group?: "top" | "bottom" | null };
type Acc = { n: number[]; sum: number[]; pos: number[]; posNet: number[] };
const acc = (k: number): Acc => ({ n: Array(k).fill(0), sum: Array(k).fill(0), pos: Array(k).fill(0), posNet: Array(k).fill(0) });
const add = (a: Acc, k: number, r: number, cost: number) => { a.n[k]++; a.sum[k] += r; if (r > 0) a.pos[k]++; if (r - cost > 0) a.posNet[k]++; };

export async function runEarningsStudy(data: DataSource, spec: EarningsSpec, log: (s: string) => void = () => {}, onProgress?: (d: number, t: number) => void) {
  const H = [...new Set((spec.horizons?.length ? spec.horizons : [5, 10, 20, 40, 60]).map((h) => Math.max(1, Math.round(h))))].sort((a, b) => a - b);
  const maxH = H.at(-1)!, cost = spec.cost ?? 0.002;
  const topPct = spec.top_pct ?? 0.1, bottomPct = spec.bottom_pct ?? 0.1, mode = spec.rank_window ?? "quarter";
  const minPrice = spec.min_price ?? 10, minDv = spec.min_avg_dollar_vol ?? 20e6, dvDays = spec.dollar_vol_lookback ?? 20, commonOnly = spec.common_only ?? true;
  const all = data.days();
  if (!all.length) throw new Error("The data set has no trading days");
  const from = spec.from ?? all[Math.min(all.length - 1, 260)], to = spec.to ?? all.at(-1)!;
  const startIdx = all.findIndex((d) => d >= from);
  let endIdx = -1;
  for (let j = 0; j < all.length; j++) if (all[j] <= to) endIdx = j;
  if (startIdx < 0 || endIdx < startIdx) throw new Error(`No trading days between ${from} and ${to}`);
  if (!data.earnings) throw new Error("This data set has no earnings dates.");
  const raw = await data.earnings();
  if (!raw.length) throw new Error("No earnings dates in the data folder: run Download earnings dates (SEC) on the Data tab first.");
  const tickers = data.tickers();

  // Events whose reaction day falls in [from, to]: i0 = last session before F, i1 = first session after F.
  const firstAfter = (d: string) => { let lo = 0, hi = all.length; while (lo < hi) { const m = (lo + hi) >> 1; if (all[m] <= d) lo = m + 1; else hi = m; } return lo; };
  const events: Ev[] = [];
  for (const e of raw) {
    const i1 = firstAfter(e.filing_date);
    let i0 = i1 - 1;
    if (i0 >= 0 && all[i0] === e.filing_date) i0--;
    if (i0 < 0 || i1 < startIdx || i1 > endIdx) continue;
    const q = `${e.filing_date.slice(0, 4)}-Q${Math.floor((Number(e.filing_date.slice(5, 7)) - 1) / 3) + 1}`;
    events.push({ ticker: e.ticker, f: e.filing_date, i0, i1, year: all[i1].slice(0, 4), quarter: q, r: H.map(() => null) });
  }
  const byI0 = new Map<number, Ev[]>(), byI1 = new Map<number, Ev[]>();
  for (const e of events) { (byI0.get(e.i0) ?? byI0.set(e.i0, []).get(e.i0)!).push(e); (byI1.get(e.i1) ?? byI1.set(e.i1, []).get(e.i1)!).push(e); }
  log(`${raw.length.toLocaleString()} earnings filings; ${events.length.toLocaleString()} with a reaction day ${all[startIdx]} → ${all[endIdx]}.`);

  // One pass: closes around each event, liquidity, entries and forward returns; per-day universe returns (baseline B).
  const firstIdx = Math.max(0, startIdx - dvDays - 5), lastIdx = Math.min(all.length - 1, endIdx + 1 + maxH);
  const dv = new Map<string, { buf: Float64Array; head: number; n: number; sum: number }>();
  const last = new Map<string, number>();
  const exits = new Map<number, { ev?: Ev; day?: number; t: string; entry: number; h: number }[]>();
  const entering = new Map<number, { ev?: Ev; day?: number; t: string }[]>();
  const dayAgg = new Map<number, { year: string; a: Acc }>(); // baseline B per entry day
  let loaded = new Map<string, Map<string, Row>>(), loadedTo = -1;
  const push = <T,>(m: Map<number, T[]>, k: number, v: T) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (onProgress && (i - firstIdx) % 20 === 0) onProgress(i - firstIdx, lastIdx - firstIdx + 1);
    if (i > loadedTo) { const t2 = Math.min(lastIdx, i + 20); loaded = await data.rows(all[i], all[t2]); loadedTo = t2; }
    const today = loaded.get(all[i]) ?? new Map<string, Row>();
    for (const [t, r] of today) {
      last.set(t, r.c);
      let x = dv.get(t);
      if (!x) dv.set(t, (x = { buf: new Float64Array(dvDays), head: 0, n: 0, sum: 0 }));
      if (x.n >= dvDays) x.sum -= x.buf[x.head];
      x.buf[x.head] = r.dv; x.sum += r.dv; x.head = (x.head + 1) % dvDays; x.n = Math.min(x.n + 1, dvDays);
    }
    // Entries at today's open, then exits at today's close.
    for (const en of entering.get(i) ?? []) {
      const bar = today.get(en.t);
      if (!bar || !(bar.o > 0)) continue;
      if (en.ev) en.ev.entry = bar.o;
      H.forEach((h, k) => { if (i + h - 1 <= lastIdx) push(exits, i + h - 1, { ...en, entry: bar.o, h: k }); });
    }
    entering.delete(i);
    for (const x of exits.get(i) ?? []) {
      const r = (last.get(x.t) ?? x.entry) / x.entry - 1;
      if (x.ev) x.ev.r[x.h] = r;
      else add(dayAgg.get(x.day!)!.a, x.h, r, cost);
    }
    exits.delete(i);
    if (i > endIdx) continue;
    const liquid = (r: Row | undefined) => {
      if (!r || !(r.c > minPrice)) return false;
      if (commonOnly) { const type = tickers.get(r.ticker)?.type; if (type && type !== "CS") return false; }
      const x = dv.get(r.ticker);
      return !!x && x.n >= dvDays && x.sum / dvDays >= minDv;
    };
    for (const e of byI0.get(i) ?? []) e.c0 = today.get(e.ticker)?.c;
    let any = false;
    for (const e of byI1.get(i) ?? []) {
      const r = today.get(e.ticker);
      if (!r || !e.c0 || !liquid(r)) continue;
      e.react = r.c / e.c0 - 1;
      if (i + 1 <= lastIdx) { push(entering, i + 1, { ev: e, t: e.ticker }); any = true; }
    }
    // Baseline B candidates: the whole liquid universe entering tomorrow (kept per day; used for signal days).
    if (any) {
      dayAgg.set(i + 1, { year: all[i].slice(0, 4), a: acc(H.length) });
      for (const r of today.values()) if (liquid(r)) push(entering, i + 1, { day: i + 1, t: r.ticker });
    }
  }

  // Rank reactions: by calendar quarter, or against the previous trailing_days sessions only.
  const valid = events.filter((e) => e.react != null);
  if (mode === "quarter") {
    const byQ = new Map<string, Ev[]>();
    for (const e of valid) (byQ.get(e.quarter) ?? byQ.set(e.quarter, []).get(e.quarter)!).push(e);
    for (const list of byQ.values()) {
      const sorted = list.map((e) => e.react!).sort((a, b) => a - b);
      for (const e of list) { const p = pctRank(sorted, e.react!); e.group = p > 1 - topPct ? "top" : p <= bottomPct ? "bottom" : null; }
    }
  } else {
    const win = spec.trailing_days ?? 63, minN = spec.min_trailing_events ?? 50;
    const sortedEv = [...valid].sort((a, b) => a.i1 - b.i1);
    let lo = 0, done = 0;
    const window: number[] = [];
    const ins = (x: number) => { let a = 0, b = window.length; while (a < b) { const m = (a + b) >> 1; if (window[m] < x) a = m + 1; else b = m; } window.splice(a, 0, x); };
    const del = (x: number) => { let a = 0, b = window.length; while (a < b) { const m = (a + b) >> 1; if (window[m] < x) a = m + 1; else b = m; } window.splice(a, 1); };
    for (const e of sortedEv) {
      while (done < sortedEv.length && sortedEv[done].i1 < e.i1) ins(sortedEv[done++].react!);
      while (lo < done && sortedEv[lo].i1 < e.i1 - win) del(sortedEv[lo++].react!);
      if (window.length < minN) { e.group = null; continue; }
      const p = pctRank(window, e.react!);
      e.group = p > 1 - topPct ? "top" : p <= bottomPct ? "bottom" : null;
    }
  }

  // Aggregate by year.
  const years = [...new Set(valid.map((e) => e.year))].sort();
  const G = { top: new Map<string, Acc>(), bottom: new Map<string, Acc>(), all: new Map<string, Acc>(), uni: new Map<string, Acc>() };
  const get = (m: Map<string, Acc>, y: string) => m.get(y) ?? m.set(y, acc(H.length)).get(y)!;
  const signalDays = new Map<string, Set<number>>();
  for (const e of valid) {
    if (e.entry == null) continue;
    e.r.forEach((r, k) => {
      if (r == null) return;
      add(get(G.all, e.year), k, r, cost);
      if (e.group === "top") add(get(G.top, e.year), k, r, cost);
      if (e.group === "bottom") add(get(G.bottom, e.year), k, r, cost);
    });
    if (e.group === "top") (signalDays.get(e.year) ?? signalDays.set(e.year, new Set()).get(e.year)!).add(e.i1 + 1);
  }
  for (const [y, set] of signalDays) for (const day of set) {
    const a = dayAgg.get(day)?.a, u = get(G.uni, y);
    if (a) for (let k = 0; k < H.length; k++) { u.n[k] += a.n[k]; u.sum[k] += a.sum[k]; u.pos[k] += a.pos[k]; u.posNet[k] += a.posNet[k]; }
  }
  const merge = (m: Map<string, Acc>, ys: string[]) => { const t = acc(H.length); for (const y of ys) { const a = m.get(y); if (a) for (let k = 0; k < H.length; k++) { t.n[k] += a.n[k]; t.sum[k] += a.sum[k]; t.pos[k] += a.pos[k]; t.posNet[k] += a.posNet[k]; } } return t; };
  const avg = (a: Acc) => H.map((_, k) => (a.n[k] ? a.sum[k] / a.n[k] : null));
  const win = (a: Acc) => H.map((_, k) => (a.n[k] ? a.pos[k] / a.n[k] : null));
  const sub = (x: (number | null)[], y: (number | null)[]) => x.map((v, k) => (v != null && y[k] != null ? v - y[k]! : null));
  const rowOf = (year: string, ys: string[]): StudyRow => {
    const top = merge(G.top, ys), bottom = merge(G.bottom, ys), allEv = merge(G.all, ys), uni = merge(G.uni, ys);
    const sig = avg(top), base = avg(uni), net = sig.map((v) => (v == null ? null : v - cost)), allAvg = avg(allEv);
    const count = (g: "top" | "bottom" | null | "any") => valid.filter((e) => ys.includes(e.year) && e.entry != null && (g === "any" || e.group === g)).length;
    return {
      year, signals: count("top"), signalDays: ys.reduce((s, y) => s + (signalDays.get(y)?.size ?? 0), 0), baseline: uni.n[0],
      sig, base, edge: sub(sig, base), sigWin: win(top), baseWin: win(uni),
      net, netEdge: sub(net, base), netWin: H.map((_, k) => (top.n[k] ? top.posNet[k] / top.n[k] : null)),
      extra: {
        all_events: { n: count("any"), avg: allAvg, win: win(allEv) },
        bottom: { n: count("bottom"), avg: avg(bottom), win: win(bottom) },
        top_minus_all_events: { n: count("top"), avg: sub(sig, allAvg), win: H.map(() => null) },
        bottom_minus_all_events: { n: count("bottom"), avg: sub(avg(bottom), allAvg), win: H.map(() => null) },
      },
    };
  };
  const result: StudyResult = {
    name: spec.name ?? "earnings_drift", strategy: "earnings_drift",
    params: { rank_window: mode, top_pct: topPct, bottom_pct: bottomPct, min_price: minPrice, min_avg_dollar_vol: minDv, ...(mode === "trailing" ? { trailing_days: spec.trailing_days ?? 63 } : {}) },
    from: all[startIdx], to: all[endIdx], horizons: H, created: new Date().toISOString(), cost, batch: null,
    rows: [...years.map((y) => rowOf(y, [y])), rowOf("All", years)],
    noEntry: { signals: valid.filter((e) => e.group === "top" && e.entry == null).length, baseline: 0 }, incomplete: 0,
  };
  const top = valid.filter((e) => e.group === "top" && e.entry != null);
  return {
    result,
    signals: top.map((e) => ({ t: e.ticker, sig: true, year: e.year, d: all[e.i1], entry: e.entry!, r: e.r })),
    events: valid,
    eventsCsv: () => ["filing_date,ticker,reaction_day,reaction,group,entry_open," + H.map((h) => `ret_${h}d`).join(","),
      ...valid.map((e) => [e.f, e.ticker, all[e.i1], e.react!.toFixed(5), e.group ?? "", e.entry?.toFixed(4) ?? "", ...e.r.map((v) => (v == null ? "" : v.toFixed(5)))].join(","))].join("\n") + "\n",
  };
}
