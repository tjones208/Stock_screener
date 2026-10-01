import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalAndSlots, MOM_DEFAULTS, normalizeMomConfig } from "./config.ts";
import { addTradingDays, isMonthEnd, isWeekEnd, nextTradingDay, tradingDaysBetween, calendarDaysBetween, type Calendar } from "./calendar.ts";
import { monthEndCloses, regimeAt } from "./regime.ts";
import { buyoutHits, nameKeys } from "./news.ts";

test("I and N from buying power (spec worked example + clamps)", () => {
  assert.deepEqual(capitalAndSlots({ ...MOM_DEFAULTS, B: 20_000 }), { I: 19_600, N: 13 });
  assert.equal(capitalAndSlots({ ...MOM_DEFAULTS, B: 10_000 }).N, 8); // B < 12,000 → N stays 8
  assert.equal(capitalAndSlots({ ...MOM_DEFAULTS, B: 1_000_000 }).N, 25);
});

test("config merges stored values over defaults and rejects junk", () => {
  const c = normalizeMomConfig({ B: "35000", E: -5, alternates: "x", fractional_shares: "on" });
  assert.equal(c.B, 35_000);
  assert.equal(c.E, MOM_DEFAULTS.E);
  assert.equal(c.alternates, MOM_DEFAULTS.alternates);
  assert.equal(c.fractional_shares, true);
});

// Sept–Oct 2026: stored days through Wed 9/30; Mon 10/12 marked as a (hypothetical) holiday.
const cal: Calendar = {
  traded: ["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"],
  holidays: new Set(["2026-10-12"]),
};

test("trading calendar: stored days, weekends, holidays; trading vs calendar days", () => {
  assert.equal(nextTradingDay(cal, "2026-09-25"), "2026-09-28");
  assert.equal(nextTradingDay(cal, "2026-09-30"), "2026-10-01");
  assert.equal(nextTradingDay(cal, "2026-10-02"), "2026-10-05");
  assert.equal(nextTradingDay(cal, "2026-10-09"), "2026-10-13"); // skips the weekend and the holiday
  assert.equal(addTradingDays(cal, "2026-10-08", 2), "2026-10-13");
  assert.equal(tradingDaysBetween(cal, "2026-10-08", "2026-10-13"), 2);
  assert.equal(calendarDaysBetween("2026-10-08", "2026-10-13"), 5);
  assert.ok(isMonthEnd(cal, "2026-09-30"));
  assert.ok(!isMonthEnd(cal, "2026-09-29"));
  assert.ok(isWeekEnd(cal, "2026-10-02"));
  assert.ok(!isWeekEnd(cal, "2026-10-01"));
  assert.ok(isWeekEnd(cal, "2026-10-09"));
});

test("regime: month-end closes vs their 10-month SMA, both ways", () => {
  const bars: { d: string; c: number }[] = [];
  // Month-end closes Dec 2025 … Sep 2026 = 100, 101, … 109, with a mid-month bar each month.
  const months = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
  months.forEach((m, i) => { bars.push({ d: `${m}-10`, c: 50 }, { d: m === "2026-09" ? "2026-09-30" : `${m}-28`, c: 100 + i }); });
  const c2: Calendar = { traded: bars.map((b) => b.d), holidays: new Set() };
  // 9/28 is not September's last trading day (9/29 and 9/30 follow), so September isn't complete yet.
  assert.equal(monthEndCloses(bars, "2026-09-28", { traded: ["2026-09-28"], holidays: new Set() }).at(-1)?.month, "2026-08");
  const on = regimeAt(bars, "2026-09-30", c2, 10);
  assert.equal(on.sma, 104.5);
  assert.equal(on.close, 109);
  assert.equal(on.riskOn, true);
  // A mid-month signal date only counts completed months.
  assert.equal(monthEndCloses(bars, "2026-09-10", c2).at(-1)?.month, "2026-08");
  // Last month-end crashes below the average → risk-off.
  const off = regimeAt(bars.map((b) => (b.d === "2026-09-30" ? { ...b, c: 90 } : b)), "2026-09-30", c2, 10);
  assert.equal(off.riskOn, false);
  assert.equal(regimeAt(bars.slice(0, 6), "2026-09-30", c2, 10).riskOn, null);
});

test("buyout headlines: target identified, acquirer spared, ambiguous → review", () => {
  const names = new Map([["ACME", "Acme Widgets Inc."], ["BIGC", "BigCo Holdings Corp"], ["ZED", "Zed Systems"]]);
  const base = { published: "2026-09-01T12:00:00Z", url: "u" };
  assert.deepEqual(nameKeys("Acme Widgets Inc."), ["acme", "widgets"]);
  assert.deepEqual(
    buyoutHits({ ...base, title: "BigCo to acquire Acme Widgets for $52.50 per share in cash", tickers: ["BIGC", "ACME"] }, names).map((h) => [h.ticker, h.kind]),
    [["ACME", "buyout_news"]],
  );
  assert.deepEqual(
    buyoutHits({ ...base, title: "Acme Widgets enters into definitive agreement to be acquired by BigCo", tickers: ["ACME", "BIGC"] }, names).map((h) => [h.ticker, h.kind]),
    [["ACME", "buyout_news"]],
  );
  assert.deepEqual(
    buyoutHits({ ...base, title: "Zed Systems agrees to be acquired by private equity", tickers: ["ZED"] }, names).map((h) => h.kind),
    ["buyout_news"],
  );
  assert.deepEqual(
    buyoutHits({ ...base, title: "Acme and BigCo announce merger agreement", tickers: ["ACME", "BIGC"] }, names).map((h) => h.kind),
    ["buyout_review", "buyout_review"],
  );
  assert.deepEqual(buyoutHits({ ...base, title: "Acme beats earnings estimates", tickers: ["ACME"] }, names), []);
});

import { clampWeights, entryCap, planPortfolio, positionShares, stopDistance, round2, type Candidate } from "./sizing.ts";

test("sizing worked example (spec 13)", () => {
  const sig = [0.32, 0.28, 0.45, 0.38, 0.25, 0.52, 0.30, 0.41, 0.35, 0.29, 0.60, 0.33, 0.27];
  const cfg = { ...MOM_DEFAULTS, B: 20_000, E: 120_000 };
  const { I, N } = capitalAndSlots(cfg);
  const w = clampWeights(sig, cfg);
  assert.ok(Math.abs(w[0] - 0.0823) <= 0.0001, `w0 = ${w[0]}`);
  const T0 = (w[0] * I * sig.length) / N;
  assert.equal(round2(T0), 1613.89);
  assert.equal(entryCap(85.0, cfg), 87.55);
  const D = stopDistance(3.1, 85.46, cfg);
  assert.equal(round2(D), 9.3);
  assert.equal(round2(85.46 - D), 76.16); // Stop0
  assert.equal(round2(85.46 - D - cfg.disaster_stop_extra * D), 71.51); // disaster stop
  // The spec's example caps risk at 0.5% of E; the default basis is now 1.5% of B.
  const s = positionShares(round2(T0), 85.46, round2(D), { ...cfg, risk_basis: "E" });
  assert.deepEqual([s.byTarget, s.byRisk, s.shares, s.tooSmall], [18, 64, 18, false]);
});

test("weight clamp converges to the band and sums to 1", () => {
  const w = clampWeights([0.05, 0.9, 0.9, 0.9, 0.9], MOM_DEFAULTS);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(w[0] - 1.5 / 5) < 1e-9, `capped at 1.5/n, got ${w[0]}`);
  for (const x of w) assert.ok(x >= 0.5 / 5 - 1e-9 && x <= 1.5 / 5 + 1e-9);
  assert.deepEqual(clampWeights([0.4], MOM_DEFAULTS), [1]);
});

const cand = (ticker: string, comp_rank: number, o: Partial<Candidate> = {}): Candidate => ({
  ticker, comp_rank, close: 50, sigma63: 0.3, atr20: 1.5, sector: "Health Care", entry_ok: true, ...o,
});

test("plan: sector name cap skips the 5th name; unknown sectors are separate buckets; alternates follow", () => {
  const cfg = { ...MOM_DEFAULTS, B: 20_000 };
  // Lower-ranked, higher-volatility Health Care names carry small weights, so the name cap (not the
  // dollar cap) is what stops the fifth one.
  const c = [
    ...Array.from({ length: 6 }, (_, i) => cand(`X${i}`, 1 + i, { sector: `S${40 + i}` })),
    cand("F", 7, { sector: null }), cand("G", 8, { sector: null }),
    cand("A", 9, { sigma63: 0.9 }), cand("B", 10, { sigma63: 0.9 }), cand("C", 11, { sigma63: 0.9 }),
    cand("D", 12, { sigma63: 0.9 }), cand("E", 13, { sigma63: 0.9 }),
    ...Array.from({ length: 8 }, (_, i) => cand(`Z${i}`, 14 + i, { sector: `S${60 + i}` })),
    cand("W", 30), // another Health Care name: not offered as an alternate once the sector is full
  ];
  const p = planPortfolio({ cfg, candidates: c, riskOn: true });
  assert.equal(p.N, 13);
  assert.equal(p.buys.length, 13);
  assert.deepEqual(p.buys.filter((b) => b.sector === "Health Care").map((b) => b.ticker), ["A", "B", "C", "D"]);
  assert.match(p.skipped.find((s) => s.ticker === "E")!.reason, /more than 4 names/);
  // Each unknown-sector name is its own bucket.
  assert.deepEqual(p.buys.filter((b) => b.sector.startsWith("unknown:")).map((b) => b.sector), ["unknown:F", "unknown:G"]);
  assert.equal(p.alternates.length, 5);
  assert.ok(p.alternates.every((a) => a.sector !== "Health Care"));
  // Targets never scale up past I and every position fits the risk cap.
  assert.ok(p.buys.reduce((s, b) => s + b.amount, 0) <= p.I + 1e-6);
  for (const b of p.buys) assert.ok(b.shares * b.D <= cfg.max_risk_pct_of_E * cfg.E + 1e-6);
});

test("plan: sector dollar cap, rule 6.7 skip, earnings watch, risk-off", () => {
  const cfg = { ...MOM_DEFAULTS, B: 20_000 };
  // 30% of I = $5,880. Low-σ names get big weights; three of them in one sector would breach.
  const low = (t: string, r: number) => cand(t, r, { sigma63: 0.1, sector: "Financials" });
  const others = Array.from({ length: 12 }, (_, i) => cand(`Y${i}`, 10 + i, { sigma63: 0.6, sector: `S${70 + i}` }));
  const p = planPortfolio({ cfg, candidates: [low("L1", 1), low("L2", 2), low("L3", 3), ...others], riskOn: true });
  const inSector = p.buys.filter((b) => b.sector === "Financials");
  assert.ok(inSector.reduce((s, b) => s + b.amount, 0) <= 0.3 * p.I + 1e-6);
  assert.ok(p.skipped.some((s) => /over 30% of I/.test(s.reason)));

  // A $2,000 stock can't be bought at all with a ~$1,500 target in whole shares → skipped.
  const pricey = planPortfolio({ cfg, candidates: [cand("BRK", 1, { close: 2000, atr20: 30, sector: "S63" }), ...others], riskOn: true });
  assert.match(pricey.skipped.find((s) => s.ticker === "BRK")!.reason, /too small/);
  assert.ok(!planPortfolio({ cfg: { ...cfg, fractional_shares: true }, candidates: [cand("BRK", 1, { close: 2000, atr20: 30 })], riskOn: true })
    .skipped.some((s) => s.ticker === "BRK"));

  const e = planPortfolio({ cfg, candidates: [cand("ERN", 1), ...others], riskOn: true, earnings: new Set(["ERN"]) });
  assert.deepEqual(e.earningsWatch.map((c) => c.ticker), ["ERN"]);
  assert.ok(!e.buys.some((b) => b.ticker === "ERN"));

  const off = planPortfolio({ cfg, candidates: others, riskOn: false });
  assert.equal(off.buys.length, 0);
  assert.match(off.message!, /risk-off/);
  assert.match(planPortfolio({ cfg: { ...cfg, B: 7_000 }, candidates: others, riskOn: true }).message!, /ETF/);
});

import { advanceTicket, buyLimits, exitLimits, fillLevels, sharesAt, type TicketState } from "./orders.ts";

test("buy and exit limits (spec worked example)", () => {
  const r = buyLimits(85.4, 85.48, 87.55);
  assert.ok(!("error" in r) && !r.noBuy);
  if (!("error" in r) && !r.noBuy) assert.deepEqual([r.lp1, r.lp2], [85.46, 85.48]);
  const capped = buyLimits(87.4, 87.6, 87.55);
  assert.ok(!("error" in capped) && capped.noBuy);
  const tight = buyLimits(87.5, 87.55, 87.55);
  assert.ok(!("error" in tight) && !tight.noBuy && tight.lp2 === 87.55 && tight.lp1 <= 87.55);
  assert.ok("error" in buyLimits(0, 1, 2));
  assert.deepEqual(exitLimits(92.8, 93.0), { xp1: 92.85, xp2: 92.8 });
  const s = sharesAt(1613.89, 85.46, 3.1, { ...MOM_DEFAULTS });
  assert.deepEqual([Math.round(s.D * 100) / 100, s.shares], [9.3, 18]);
});

test("fill levels: D fixed from ATR at signal, Stop0, disaster stop, long-term date", () => {
  const lv = fillLevels(85.46, 3.1, "2026-10-01", MOM_DEFAULTS);
  assert.deepEqual(lv, { D: 9.3, stop0: 76.16, disaster: 71.51, ltDate: "2027-10-02" });
  // D clamps to 10% / 20% of F.
  assert.equal(fillLevels(100, 1, "2026-10-01", MOM_DEFAULTS).D, 10);
  assert.equal(fillLevels(100, 10, "2026-10-01", MOM_DEFAULTS).D, 20);
});

test("ticket retries: same cap, day-3 keep or drop (never reset upward), drop after 5 sessions", () => {
  const cfg = MOM_DEFAULTS;
  const t0: TicketState = { status: "open", retry_day: 1, trade_date: "2026-10-01", s_close: 50, cap: 51.5 };
  const d2 = advanceTicket(t0, "2026-10-02", { entry_ok: true, close: 55 }, cfg);
  assert.deepEqual([d2.retry_day, d2.cap, d2.trade_date, d2.promote], [2, 51.5, "2026-10-02", false]);
  // Day 3, close at or under the original cap: keep the original S and cap.
  const d3 = advanceTicket(d2, "2026-10-05", { entry_ok: true, close: 51.5 }, cfg);
  assert.deepEqual([d3.retry_day, d3.s_close, d3.cap, d3.status, d3.promote], [3, 50, 51.5, "open", false]);
  // Day 3, close above the original cap: drop and promote the next alternate.
  const up3 = advanceTicket(d2, "2026-10-05", { entry_ok: true, close: 55 }, cfg);
  assert.deepEqual([up3.status, up3.promote, up3.s_close, up3.cap], ["dropped", true, 50, 51.5]);
  assert.match(up3.note!, /above the cap 51\.50/);
  const fail3 = advanceTicket(d2, "2026-10-05", { entry_ok: false, close: 55 }, cfg);
  assert.deepEqual([fail3.status, fail3.promote], ["dropped", true]);
  const d5: TicketState = { ...d3, retry_day: 5, trade_date: "2026-10-07" };
  const d6 = advanceTicket(d5, "2026-10-08", { entry_ok: true, close: 55 }, cfg);
  assert.deepEqual([d6.status, d6.promote], ["dropped", true]);
  // Same session or already filled: no change.
  assert.equal(advanceTicket(t0, "2026-10-01", null, cfg).retry_day, 1);
  assert.equal(advanceTicket({ ...t0, status: "filled" }, "2026-10-02", null, cfg).status, "filled");
});

import { disasterStop, exitResult, pickLots, reviewPosition, topUpShares, trailStop, type Lot, type Position } from "./stops.ts";

test("trailing stop, disaster stop and stop exit (spec worked example)", () => {
  const cfg = MOM_DEFAULTS;
  let stop = 76.16;
  stop = trailStop(stop, 102.3, 9.3);
  assert.equal(stop, 93.0);
  assert.equal(disasterStop(stop, 9.3, cfg), 88.35);
  // Never lower: a lower high close later can't pull the stop down.
  assert.equal(trailStop(stop, 95, 9.3), 93.0);
  const lot: Lot = { id: 1, ticker: "X", shares: 18, fill_price: 85.46, d: 9.3, stop: 93.0, filled_at: "2026-10-01T14:00:00Z", lt_date: "2027-10-02" };
  const p: Position = { ticker: "X", lots: [lot], close: 92.8, active: true, holdOk: true, buyoutNews: null, target: null, entryOk: true };
  const o = reviewPosition(p, { monthEnd: false, riskOn: true, cfg })!;
  assert.deepEqual([o.trigger, o.shares, o.urgent], [2, 18, true]);
  assert.deepEqual(exitResult(lot, 92.9, 18, 0, "2026-11-02"), { pnl: 133.92, r: 0.8, term: "ST" });
  assert.equal(exitResult(lot, 92.9, 18, 0, "2027-10-02").term, "LT");
});

const lotAt = (id: number, fill: number, shares = 10, stop = 1): Lot =>
  ({ id, ticker: "Y", shares, fill_price: fill, d: 5, stop, filled_at: "2026-10-01T14:00:00Z", lt_date: "2027-10-02" });
const pos = (o: Partial<Position> = {}): Position =>
  ({ ticker: "Y", lots: [lotAt(1, 50)], close: 60, active: true, holdOk: true, buyoutNews: null, target: 600, entryOk: true, ...o });

test("exit triggers in spec order; month-end-only triggers wait for month-end", () => {
  const cfg = MOM_DEFAULTS;
  const me = { monthEnd: true, riskOn: true, cfg };
  // Regime turns risk-off at month-end → sell everything (beats every other trigger).
  assert.equal(reviewPosition(pos({ close: 0.5, holdOk: false }), { ...me, riskOn: false })!.trigger, 1);
  // Mid-month risk-off does nothing (the regime is monthly only).
  assert.equal(reviewPosition(pos(), { monthEnd: false, riskOn: false, cfg }), null);
  assert.equal(reviewPosition(pos({ close: 0.9, holdOk: false }), me)!.trigger, 2);
  assert.equal(reviewPosition(pos({ holdOk: false }), me)!.trigger, 3);
  assert.equal(reviewPosition(pos({ holdOk: null }), me)!.trigger, 3);
  assert.equal(reviewPosition(pos({ holdOk: false }), { ...me, monthEnd: false }), null);
  const b = reviewPosition(pos({ buyoutNews: "2026-10-05" }), { ...me, monthEnd: false })!;
  assert.deepEqual([b.trigger, b.deadlineDays], [4, 5]);
  assert.equal(reviewPosition(pos({ close: null }), { ...me, monthEnd: false })!.trigger, 5);
  assert.equal(reviewPosition(pos({ active: false }), { ...me, monthEnd: false })!.trigger, 5);
});

test("trim over 2× target back to 1.5×, losing lots first then highest cost; top-up under 0.5×", () => {
  const cfg = MOM_DEFAULTS;
  // 3 lots, 30 shares at $60 = $1,800 vs target $600 → trim to $900 = 15 shares, sell 15.
  const lots = [lotAt(1, 40), lotAt(2, 70), lotAt(3, 55)];
  const o = reviewPosition(pos({ lots, target: 600 }), { monthEnd: true, riskOn: true, cfg })!;
  assert.equal(o.trigger, 7);
  assert.equal(o.shares, 15);
  assert.deepEqual(o.lots, [{ id: 2, shares: 10 }, { id: 3, shares: 5 }]); // $70 lot is a loss at $60 → first; then $55 (highest cost)
  assert.deepEqual(pickLots(lots, 12, 60, false).map((l) => l.id), [2, 3]);
  // Not over 2×: no trim.
  assert.equal(reviewPosition(pos({ lots: [lotAt(1, 50, 20)], target: 700 }), { monthEnd: true, riskOn: true, cfg }), null);
  // $240 held vs $600 target (< 0.5×) and still entry-eligible → buy 6 more at $60.
  assert.equal(topUpShares(pos({ lots: [lotAt(1, 50, 4)] }), cfg), 6);
  assert.equal(topUpShares(pos({ lots: [lotAt(1, 50, 4)], entryOk: false }), cfg), 0);
  assert.equal(topUpShares(pos({ lots: [lotAt(1, 50, 6)] }), cfg), 0);
});

import { formatSellPush } from "./notify-format.ts";

test("morning push text: sells with reasons, or a daily no-sell summary", () => {
  const m = formatSellPush("2026-10-05", [
    { ticker: "AMRX", shares_to_sell: 56, exit_trigger: 2, urgent: true, deadline: "2026-10-05", note: "Closed 22.60 at or below the stop 22.65." },
    { ticker: "VTRS", shares_to_sell: 85, exit_trigger: 3, urgent: false, deadline: "2026-10-05", note: "Failed the month-end hold test." },
  ], 13);
  assert.equal(m.title, "Momentum Mon, Oct 5: 2 sells at 9:45");
  assert.match(m.body, /^SELL AMRX 56 sh \(today\): Stop hit — Closed 22.60/);
  assert.match(m.body, /SELL VTRS 85 sh \(by 2026-10-05\): Dropped off \(failed hold test\)/);
  assert.deepEqual(formatSellPush("2026-10-06", [], 13), { title: "Momentum Tue, Oct 6: no sells", body: "Hold all 13 lots; stops are updated on the Momentum tab." });
});

import { manualWarnings, type ManualCheck } from "./manual-rules.ts";

test("hand-added positions: warnings for each broken rule, none when it fits", () => {
  const cfg = MOM_DEFAULTS;
  const ok: ManualCheck = {
    holding: false, inUniverse: true, entryOk: true, riskOn: true, rebalanceDay: false, heldCount: 5, N: 13, I: 19_600,
    sector: "28", sectorNamesAfter: 2, sectorDollarsAfter: 3000, shares: 56, price: 21.12, D: 2.35, target: 1189, valueBefore: 0,
  };
  assert.deepEqual(manualWarnings(ok, cfg), []);
  const bad = manualWarnings({ ...ok, inUniverse: false, heldCount: 13, sectorNamesAfter: 5, sectorDollarsAfter: 7000, shares: 300, riskOn: false }, cfg);
  assert.equal(bad.length, 7);
  assert.match(bad.join(" "), /risk-on.*universe.*open slot.*5 names.*over 30%.*Risk to the stop is \$705.*over its target/);
  assert.match(manualWarnings({ ...ok, entryOk: false }, cfg)[0], /Fails the entry test/);
  // Adding shares: allowed at month-end under half the target; otherwise it's a rule break.
  const top = { ...ok, holding: true, valueBefore: 400, shares: 30, target: 1189 };
  assert.deepEqual(manualWarnings({ ...top, rebalanceDay: true }, cfg), []);
  assert.match(manualWarnings(top, cfg)[0], /Top-ups are only allowed at month-end/);
});

import { callsToClose, callWindow, coverableContracts, monthEndOf, occCall } from "./calls.ts";

test("covered calls: round lots only, expire before month-end and earnings", () => {
  const cfg = MOM_DEFAULTS;
  assert.equal(coverableContracts(168, 0), 1);
  assert.equal(coverableContracts(99, 0), 0);
  assert.equal(coverableContracts(250, 1), 1);
  const cal: Calendar = { traded: ["2026-09-30"], holidays: new Set() };
  assert.equal(monthEndOf(cal, "2026-10-01"), "2026-10-30");
  assert.deepEqual(callWindow(cal, "2026-10-01", null, cfg), { gte: "2026-10-06", lte: "2026-10-30", monthEnd: "2026-10-30" });
  // Earnings on 10/22 → must expire by 10/21.
  assert.equal(callWindow(cal, "2026-10-01", "2026-10-22", cfg)!.lte, "2026-10-21");
  // Too late in the month to leave min_dte before month-end → no call.
  assert.equal(callWindow(cal, "2026-10-27", null, cfg), null);

  assert.equal(occCall("DRH", "2026-10-30", 14), "DRH261030C00014000");
  assert.equal(occCall("F", "2026-11-20", 12.5), "F261120C00012500");
  // Before selling shares: close all calls on a full exit; on a trim keep what remaining shares cover.
  assert.equal(callsToClose(168, 168, 1), 1);
  assert.equal(callsToClose(250, 100, 2), 1);
  assert.equal(callsToClose(250, 40, 2), 0);
});

test("morning push lists likely covered-call assignments", () => {
  const m = formatSellPush("2026-10-19", [], 13, [{ ticker: "DRH", contracts: 1, strike: 14 }]);
  assert.equal(m.title, "Momentum Mon, Oct 19: 1 covered call assigned?");
  assert.equal(m.body, "CALLED AWAY? DRH 100 sh at 14: confirm on the Momentum tab");
});

import { momSector, sectorLabel } from "./sector-key.ts";
import { sectorFromSic } from "../sectors.ts";

test("GICS sector keys: S&P GICS first, then 4-digit SIC, then 2-digit, else a per-ticker unknown", () => {
  // SIC 3826 (lab analytical instruments: TXG, BRKR) is Health Care, not IT — even with a stale IT label.
  assert.equal(sectorFromSic("3826"), "Health Care");
  assert.equal(momSector({ ticker: "TXG", in_sp500: false, sector: "Information Technology", sic_code: "3826" }), "Health Care");
  for (const sic of ["2833", "2834", "2836", "3841", "3845", "3851", "5047", "5122", "8000", "8071", "8099", "8731"]) {
    assert.equal(sectorFromSic(sic), "Health Care", sic);
  }
  // S&P 500 names use their real GICS sector even when the SIC would say otherwise.
  assert.equal(momSector({ ticker: "X", in_sp500: true, sector: "Financials", sic_code: "2834" }), "Financials");
  // No 4-digit code: the 2-digit group; nothing at all: its own bucket.
  assert.equal(momSector({ ticker: "Y", sic2: "13" }), "Energy");
  assert.equal(momSector({ ticker: "AAA" }), "unknown:AAA");
  assert.notEqual(momSector({ ticker: "AAA" }), momSector({ ticker: "BBB" }));
  assert.equal(sectorLabel("unknown:AAA"), "Unknown");
});

test("six Health Care names under SIC 28, 38 and 80 (and S&P GICS) → only 4 bought, the rest skipped for the sector", () => {
  const cfg = { ...MOM_DEFAULTS, B: 20_000 };
  const hc = [
    { ticker: "TWST", sic_code: "2836" }, { ticker: "ABCL", sic_code: "2834" }, { ticker: "TXG", sic_code: "3826", sector: "Information Technology" },
    { ticker: "ILMN", sic_code: "3826", in_sp500: true, sector: "Health Care" }, { ticker: "CDNA", sic_code: "8071" }, { ticker: "NTRA", sic_code: "8071" },
  ];
  const sectorsSeen = new Set(hc.map((h) => (h.sic_code ?? "").slice(0, 2)));
  assert.deepEqual([...sectorsSeen].sort(), ["28", "38", "80"]);
  const others = ["Information Technology", "Information Technology", "Industrials", "Industrials", "Energy", "Financials", "Utilities", "Materials"]
    .map((sector, i) => cand(`O${i}`, 1 + i, { sector }));
  const late = ["Consumer Staples", "Real Estate", "Communication Services"].map((sector, i) => cand(`L${i}`, 20 + i, { sector }));
  const candidates = [
    ...others,
    ...hc.map((h, i) => cand(h.ticker, 9 + i, { sigma63: 0.9, sector: momSector(h) })),
    ...late,
  ];
  const p = planPortfolio({ cfg, candidates, riskOn: true });
  const boughtHc = p.buys.filter((b) => b.sector === "Health Care");
  assert.equal(boughtHc.length, 4);
  assert.deepEqual(boughtHc.map((b) => b.ticker), ["TWST", "ABCL", "TXG", "ILMN"]);
  const skippedHc = p.skipped.filter((s) => ["CDNA", "NTRA"].includes(s.ticker));
  assert.equal(skippedHc.length, 2);
  for (const s of skippedHc) assert.match(s.reason, /^Sector Health Care: /);
  // The freed slot goes to the next name in another sector.
  assert.equal(p.buys.length, 13);
  assert.ok(p.buys.some((b) => b.ticker === "L0"));
  assert.ok(boughtHc.reduce((a, b) => a + b.amount, 0) <= cfg.sector_max_pct_of_I * p.I + 1e-6);
});

test("unknown-sector names don't share a cap", () => {
  const cfg = { ...MOM_DEFAULTS, B: 20_000 };
  // Five names with no sector data: a shared bucket would stop the fifth at the 4-name cap.
  const unknowns = ["U1", "U2", "U3", "U4", "U5"].map((t, i) => cand(t, 1 + i, { sigma63: 0.9, sector: momSector({ ticker: t }) }));
  const fill = ["Energy", "Financials", "Utilities", "Materials", "Industrials", "Real Estate", "Consumer Staples", "Communication Services"]
    .map((sector, i) => cand(`F${i}`, 10 + i, { sector }));
  const p = planPortfolio({ cfg, candidates: [...unknowns, ...fill], riskOn: true });
  assert.deepEqual(p.buys.filter((b) => b.sector.startsWith("unknown:")).map((b) => b.ticker), ["U1", "U2", "U3", "U4", "U5"]);
  assert.ok(!p.skipped.some((s) => s.ticker.startsWith("U")));
});

// --- Buy safety: data-quality gate and earnings check ---
import { dataGate, earningsChecked } from "./quality.ts";
import { earningsWarning } from "./notify-format.ts";

const good = { universe: 1551, no_mcap: 4, news_days: 90 };

test("earnings blackout defaults to 5 trading days", () => {
  assert.equal(MOM_DEFAULTS.earnings_blackout_days, 5);
});

test("gate passes on clean data", () => {
  const g = dataGate({ ...good, universe: 1600 }, { signal_date: "2026-09-29", quality: good }, MOM_DEFAULTS);
  assert.deepEqual(g, { ok: true, reasons: [], comparedTo: "2026-09-29" });
});

test("gate blocks when more than 50 liquid names lack a market cap", () => {
  assert.equal(dataGate({ ...good, no_mcap: 50 }, null, MOM_DEFAULTS).ok, true);
  const g = dataGate({ ...good, no_mcap: 51 }, null, MOM_DEFAULTS);
  assert.equal(g.ok, false);
  assert.match(g.reasons[0], /51 liquid stocks have no market cap/);
});

test("gate blocks when the news sweep covers fewer than 85 of 90 days", () => {
  assert.equal(dataGate({ ...good, news_days: 85 }, null, MOM_DEFAULTS).ok, true);
  assert.match(dataGate({ ...good, news_days: 84 }, null, MOM_DEFAULTS).reasons[0], /covers 84 of the last 90 days/);
  assert.equal(dataGate({ ...good, news_days: null }, null, MOM_DEFAULTS).ok, false);
});

test("gate blocks a universe change over 25% against a clean previous run", () => {
  const prev = { signal_date: "2026-09-29", quality: good };
  assert.equal(dataGate({ ...good, universe: Math.floor(1551 * 1.25) }, prev, MOM_DEFAULTS).ok, true);
  const up = dataGate({ ...good, universe: 1940 }, prev, MOM_DEFAULTS);
  assert.equal(up.ok, false);
  assert.match(up.reasons[0], /universe changed 25% since 2026-09-29/);
  const down = dataGate({ ...good, universe: 1100 }, prev, MOM_DEFAULTS);
  assert.match(down.reasons[0], /universe changed -29% since 2026-09-29 \(1551 → 1100/);
});

test("gate skips the universe comparison when either run failed the market-cap check", () => {
  // 9/28 → 9/29: 376 → 1,551 (+312%) while market caps backfilled; 9/28 had 1,563 missing.
  const g = dataGate(good, { signal_date: "2026-09-28", quality: { universe: 376, no_mcap: 1563, news_days: 32 } }, MOM_DEFAULTS);
  assert.deepEqual(g, { ok: true, reasons: [], comparedTo: null });
  // And a run that itself fails the market-cap check is blocked for that, not compared.
  const bad = dataGate({ universe: 376, no_mcap: 1563, news_days: 90 }, { signal_date: "2026-09-29", quality: good }, MOM_DEFAULTS);
  assert.equal(bad.comparedTo, null);
  assert.equal(bad.reasons.length, 1);
});

test("earnings check: a sync error or no future rows means unchecked", () => {
  assert.deepEqual(earningsChecked(4200, null), { ok: true, reason: null });
  assert.equal(earningsChecked(0, null).ok, false);
  assert.match(earningsChecked(4200, "Finnhub 429").reason!, /sync failed \(Finnhub 429\)/);
});

test("morning push leads with the earnings-unchecked warning", () => {
  assert.equal(earningsWarning(0), null);
  const w = earningsWarning(13)!;
  assert.equal(w, "⚠ Earnings unchecked: 13 buy orders today weren't screened for earnings — check each before buying");
  const m = formatSellPush("2026-10-01", [], 0, [], [w]);
  assert.equal(m.title, "Momentum Thu, Oct 1: no sells");
  assert.equal(m.body, `${w}\nNo open positions.`);
  assert.equal(earningsWarning(1), "⚠ Earnings unchecked: 1 buy order today wasn't screened for earnings — check each before buying");
});

// ───────────── Part B ─────────────
import { nightlyStop, gtcNeedsUpdate, applyLtDeferral, dueDeferrals, ltWindow, type ExitOrder } from "./stops.ts";
import { regimeState } from "./regime.ts";
import { realizedVol, volScale, washBlocked, isWashBuy } from "./risk.ts";
import { holdCutoff, rankUniverse, entryOk, holdVerdict, type RuleRow } from "./ranking.ts";
import { equityRow, trailingReturn, killSwitch, tradeStats, idleCash, type EquityRow } from "./journal.ts";
import { gtcLines, volLine, monthEndLines, isUrgentAlertTime, formatUrgentPush } from "./notify-format.ts";
import { tickerPatch, sum4 } from "../fundamentals-calc.ts";

const lotB = (o: Partial<Lot> = {}): Lot => ({ id: 1, ticker: "AAA", shares: 10, fill_price: 100, d: 10, stop: 90, filled_at: "2025-10-01T14:00:00Z", lt_date: "2026-10-02", ...o });

test("1. trailing stop resizes with price: 192 → 400 stays a 10–20% trail and never moves down", () => {
  const cfg = MOM_DEFAULTS;
  const entry = fillLevels(192, 10.4, "2026-01-05", cfg);
  assert.equal(entry.D, 31.2); // 3 × 10.4, inside [19.2, 38.4]
  let stop = entry.stop0, hc = 192;
  const path = [[210, 11], [250, 13], [240, 15], [300, 16], [360, 19], [400, 21], [380, 24]] as const;
  for (const [close, atr] of path) {
    hc = Math.max(hc, close);
    const n = nightlyStop(stop, hc, close, atr, entry.D, cfg);
    assert.ok(n.stop >= stop, `stop never moves down (${n.stop} < ${stop})`);
    const trail = n.dTrail / close;
    assert.ok(trail >= 0.1 - 1e-9 && trail <= 0.2 + 1e-9, `trail ${trail} within 10–20%`);
    assert.equal(n.disaster, round2(n.stop - cfg.disaster_stop_extra * n.dTrail));
    stop = n.stop;
  }
  // At $400 with ATR $21: D_t = 63 (15.75%), stop = 400 − 63 = 337, far above the fixed-$31.20 trail's percentage.
  const at400 = nightlyStop(0, 400, 400, 21, entry.D, cfg);
  assert.deepEqual([at400.dTrail, at400.stop], [63, 337]);
  // lots.d stays the initial risk: the entry D is unchanged.
  assert.equal(entry.D, 31.2);
  // No ATR today: falls back to the entry distance.
  assert.equal(nightlyStop(300, 400, 400, null, 31.2, cfg).dTrail, 31.2);
});

test("2. hold buffer: cutoff = max(2 × N, ceil(20% × universe))", () => {
  assert.equal(holdCutoff(MOM_DEFAULTS, 13, 1551), 311);
  assert.equal(holdCutoff({ ...MOM_DEFAULTS, hold_rank_pct: 0 }, 13, 1551), 26);
  assert.equal(holdCutoff(MOM_DEFAULTS, 13, 100), 26);
  const r: RuleRow = { mom: 0.4, mom_pct: 80, h52: 0.9, days_since_high: 5, comp_rank: 200, close: 50, median_dv60: 3e7, buyoutReview: false, inUniverse: true };
  assert.equal(holdVerdict(r, MOM_DEFAULTS, 26).ok, false);
  assert.equal(holdVerdict(r, MOM_DEFAULTS, 311).ok, true);
});

test("3. ranking: risk_adj = 0.75 × pct(mom/σ252) + 0.25 × H52 pct, ties by mom; classic is 50/50", () => {
  const rows = [
    { ticker: "HOT", mom: 1.2, h52: 0.95, sigma252: 1.2 },   // big move, very volatile: mom/σ = 1.0
    { ticker: "STEADY", mom: 0.6, h52: 0.97, sigma252: 0.2 }, // mom/σ = 3.0
    { ticker: "MID", mom: 0.5, h52: 0.9, sigma252: 0.25 },    // 2.0
    { ticker: "NOSIG", mom: 0.9, h52: 0.99, sigma252: null }, // no σ252 → bottom of the risk percentile
  ];
  const ra = rankUniverse(rows, "risk_adj"), cl = rankUniverse(rows, "classic");
  assert.equal(ra[0].ticker, "STEADY");
  assert.equal(cl[0].ticker, "NOSIG");
  const steady = ra.find((r) => r.ticker === "STEADY")!;
  assert.ok(Math.abs(steady.risk_adj - (0.75 * 100 + 0.25 * (200 / 3))) < 1e-9);
  // Tie on composite → higher momentum first.
  const tie = rankUniverse([{ ticker: "A", mom: 0.3, h52: 0.9, sigma252: 0.3 }, { ticker: "B", mom: 0.6, h52: 0.9, sigma252: 0.6 }], "risk_adj");
  assert.deepEqual(tie.map((r) => r.ticker), ["B", "A"]);
  assert.equal(MOM_DEFAULTS.rank_method, "risk_adj");
  assert.equal(normalizeMomConfig({ rank_method: "classic" }).rank_method, "classic");
  assert.equal(normalizeMomConfig({ rank_method: "nonsense" }).rank_method, "risk_adj");
});

const ruleRow = (o: Partial<RuleRow> = {}): RuleRow => ({ mom: 0.4, mom_pct: 90, h52: 0.95, days_since_high: 3, comp_rank: 5, close: 50, median_dv60: 3e7, buyoutReview: false, inUniverse: true, ...o });

test("4. absolute momentum: entry needs mom > abs_mom_min; hold unchanged", () => {
  assert.equal(entryOk(ruleRow(), MOM_DEFAULTS), true);
  assert.equal(entryOk(ruleRow({ mom: -0.02, mom_pct: 75 }), MOM_DEFAULTS), false);
  assert.equal(entryOk(ruleRow({ mom: 0 }), MOM_DEFAULTS), false);
  assert.equal(entryOk(ruleRow({ mom: 0.05 }), { ...MOM_DEFAULTS, abs_mom_min: 0.1 }), false);
  assert.equal(holdVerdict(ruleRow({ mom: -0.02, mom_pct: 75 }), MOM_DEFAULTS, 26).ok, true);
});

test("5. buyout review: fails entry and hold → month-end exit 'possible pending buyout'; cleared → normal", () => {
  const flagged = ruleRow({ buyoutReview: true });
  assert.equal(entryOk(flagged, MOM_DEFAULTS), false);
  const v = holdVerdict(flagged, MOM_DEFAULTS, 26);
  assert.deepEqual(v, { ok: false, reason: "Possible pending buyout" });
  const p: Position = { ticker: "AAA", lots: [lotB({ lt_date: "2027-12-01" })], close: 120, active: true, holdOk: v.ok, holdReason: v.reason, buyoutNews: null, target: 1000, entryOk: false };
  const o = reviewPosition(p, { monthEnd: true, riskOn: true, cfg: MOM_DEFAULTS })!;
  assert.equal(o.trigger, 3);
  assert.match(o.reason, /possible pending buyout/);
  const cleared = holdVerdict(ruleRow({ buyoutReview: false }), MOM_DEFAULTS, 26);
  assert.equal(cleared.ok, true);
  assert.equal(entryOk(ruleRow(), MOM_DEFAULTS), true);
});

test("6. data glitches don't force sales: held name with a missing_day flag and no market cap is kept", () => {
  // Outside the universe (flag + null market cap) but the hold test on its bars passes.
  const outside = ruleRow({ inUniverse: false, comp_rank: 40 });
  const v = holdVerdict(outside, MOM_DEFAULTS, holdCutoff(MOM_DEFAULTS, 13, 1551));
  assert.equal(v.ok, true);
  const p: Position = { ticker: "GLCH", lots: [lotB()], close: 110, active: true, holdOk: v.ok, buyoutNews: null, target: 1100, entryOk: false };
  assert.equal(reviewPosition(p, { monthEnd: true, riskOn: true, cfg: MOM_DEFAULTS }), null);
  // Only real problems: price under the minimum, or liquidity under half the minimum.
  assert.match(holdVerdict(ruleRow({ inUniverse: false, close: 8 }), MOM_DEFAULTS, 311).reason!, /Close below/);
  assert.match(holdVerdict(ruleRow({ median_dv60: 9e6 }), MOM_DEFAULTS, 311).reason!, /half the minimum/);
  assert.equal(holdVerdict(ruleRow({ median_dv60: 1.1e7 }), MOM_DEFAULTS, 311).ok, true);
});

test("7. regime band: risk-on stays on until SMA × 0.98; risk-off needs SMA", () => {
  const band = MOM_DEFAULTS.regime_band_pct;
  assert.equal(band, 0.02);
  // From risk-on: 1% under the SMA stays on, 3% under goes off.
  assert.equal(regimeState(99, 100, true, band), true);
  assert.equal(regimeState(98, 100, true, band), true);
  assert.equal(regimeState(97, 100, true, band), false);
  // From risk-off: 1% under stays off; at the SMA goes on.
  assert.equal(regimeState(99, 100, false, band), false);
  assert.equal(regimeState(100, 100, false, band), true);
  // Unknown prior: plain rule.
  assert.equal(regimeState(99, 100, null, band), false);
  assert.equal(regimeState(100, 100, null, band), true);
});

test("8. volatility brake: m = clamp(0.18 / SPY vol, 0.25, 1); targets scale; trims only via volTarget", () => {
  const calm = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.002 * (i % 2 ? 1 : -1)));
  const wild = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.04 * (i % 2 ? 1 : -1)));
  assert.equal(volScale(calm, MOM_DEFAULTS).m, 1);
  const w = volScale(wild, MOM_DEFAULTS);
  assert.ok(w.vol! > 1);
  assert.equal(w.m, 0.25); // floor
  const mid = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.0167 * (i % 2 ? 1 : -1)));
  const mm = volScale(mid, MOM_DEFAULTS);
  assert.ok(Math.abs(mm.m - 0.18 / mm.vol!) < 1e-12 && mm.m > 0.25 && mm.m < 1);
  assert.equal(volScale(wild, { ...MOM_DEFAULTS, vol_scale: false }).m, 1);
  assert.equal(realizedVol([1, 2], 21), null);
  // New buys and alternates use T × m.
  const cfg = { ...MOM_DEFAULTS, B: 20_000 };
  const cands = ["Energy", "Financials", "Utilities"].map((sector, i) => cand(`V${i}`, i + 1, { sector }));
  const full = planPortfolio({ cfg, candidates: cands, riskOn: true });
  const half = planPortfolio({ cfg, candidates: cands, riskOn: true, scale: 0.5 });
  assert.ok(Math.abs(half.buys[0].T - full.buys[0].T * 0.5) < 1e-9);
  // Brake trim (trigger 9) to m × target: non-urgent, only when volTarget is set (weekly/monthly).
  const p: Position = { ticker: "AAA", lots: [lotB({ shares: 20, lt_date: "2027-12-01" })], close: 100, active: true, holdOk: true, buyoutNews: null, target: null, entryOk: true, volTarget: 1000 };
  const o = reviewPosition(p, { monthEnd: false, riskOn: true, cfg: MOM_DEFAULTS })!;
  assert.deepEqual([o.trigger, o.shares, o.urgent], [9, 10, false]);
  assert.equal(reviewPosition({ ...p, volTarget: null }, { monthEnd: false, riskOn: true, cfg: MOM_DEFAULTS }), null);
  assert.equal(TRIGGER_LABEL_9(), "Volatility brake");
  assert.equal(volLine(1, 0.6), null);
  assert.match(volLine(0.5, 0.6)!, /m = 0\.50: new buys at 50% of target; trims/);
});
import { TRIGGER_LABEL } from "./stops.ts";
const TRIGGER_LABEL_9 = () => TRIGGER_LABEL[9];

test("9a. wash sale: loss exits block buys for 31 days, gains never; flagged on manual add and new lots", () => {
  const closed = [
    { ticker: "LOSS", exit_date: "2026-09-15", pnl: -120 },
    { ticker: "GAIN", exit_date: "2026-09-15", pnl: 300 },
    { ticker: "OLD", exit_date: "2026-08-01", pnl: -50 },
  ];
  const w = washBlocked(closed, "2026-09-30", MOM_DEFAULTS.wash_sale_block_days);
  assert.deepEqual([...w.keys()], ["LOSS"]);
  const cfg = { ...MOM_DEFAULTS, B: 20_000 };
  const p = planPortfolio({ cfg, candidates: [cand("LOSS", 1, { sector: "Energy" }), cand("GAIN", 2, { sector: "Utilities" })], riskOn: true, washBlocked: new Set(w.keys()) });
  assert.deepEqual(p.buys.map((b) => b.ticker), ["GAIN"]);
  assert.deepEqual(p.skipped, [{ ticker: "LOSS", comp_rank: 1, reason: "Wash-sale block" }]);
  assert.equal(isWashBuy(closed, "LOSS", "2026-10-10"), true);
  assert.equal(isWashBuy(closed, "LOSS", "2026-10-20"), false);
  assert.equal(isWashBuy(closed, "GAIN", "2026-09-20"), false);
  const warn = manualWarnings({ ...manualBase(), washSaleSince: "2026-09-15" }, MOM_DEFAULTS);
  assert.ok(warn.some((x) => /Wash sale: sold at a loss on 2026-09-15/.test(x)));
});

test("9b. LT deferral: triggers 3, 7, 9 wait for lt_date on gains; 1, 2, 4, 5 never wait", () => {
  const t = "2026-09-30";
  const near = lotB({ id: 1, fill_price: 100, lt_date: "2026-10-20" }); // 20 days out, gain at 120
  const far = lotB({ id: 2, fill_price: 100, lt_date: "2027-03-01" });
  assert.equal(ltWindow(near, 120, t, MOM_DEFAULTS), true);
  assert.equal(ltWindow(near, 95, t, MOM_DEFAULTS), false); // a loss isn't deferred
  const hold: ExitOrder = { ticker: "AAA", trigger: 3, lots: [{ id: 1, shares: 10 }, { id: 2, shares: 10 }], shares: 20, reason: "Failed the month-end hold test.", urgent: false, deadlineDays: 0 };
  const r = applyLtDeferral(hold, [near, far], 120, t, MOM_DEFAULTS);
  assert.deepEqual(r.order!.lots, [{ id: 2, shares: 10 }]);
  assert.match(r.order!.reason, /deferred for LT until 2026-10-20/);
  assert.deepEqual(r.deferred, [{ id: 1, shares: 10, lt_date: "2026-10-20" }]);
  for (const trigger of [1, 2, 4, 5] as const) {
    const o = applyLtDeferral({ ...hold, trigger }, [near, far], 120, t, MOM_DEFAULTS);
    assert.equal(o.deferred.length, 0);
    assert.equal(o.order!.shares, 20);
  }
  // Only the near lot: the whole order waits.
  assert.equal(applyLtDeferral({ ...hold, lots: [{ id: 1, shares: 10 }], shares: 10 }, [near], 120, t, MOM_DEFAULTS).order, null);
  // Due on lt_date (or when the gain is gone).
  const waiting = { ...near, lt_deferred_trigger: 3 };
  assert.equal(dueDeferrals([waiting], 120, "2026-10-19").length, 0);
  assert.equal(dueDeferrals([waiting], 120, "2026-10-20").length, 1);
  assert.equal(dueDeferrals([waiting], 99, "2026-10-01").length, 1);
});

test("10. risk cap basis: 1.5% of B by default, or 0.5% of E", () => {
  const cfg = { ...MOM_DEFAULTS, B: 20_000, E: 120_000 };
  assert.equal(positionShares(5000, 50, 5, cfg).byRisk, 60);                        // $300 / $5
  assert.equal(positionShares(5000, 50, 5, { ...cfg, risk_basis: "E" }).byRisk, 120); // $600 / $5
  const w = manualWarnings({ ...manualBase(), shares: 70, D: 5 }, cfg);
  assert.ok(w.some((x) => /1\.5% of buying power limit \(\$300\)/.test(x)));
  assert.equal(normalizeMomConfig({ risk_basis: "E" }).risk_basis, "E");
});

test("11. covered calls are off by default", () => {
  assert.equal(MOM_DEFAULTS.covered_calls, false);
});

test("13. execution alerts: 10:30 ET in EDT and EST; GTC update when ≥ 2% above posted", () => {
  assert.equal(isUrgentAlertTime(new Date("2026-10-01T14:30:00Z")), true);  // EDT
  assert.equal(isUrgentAlertTime(new Date("2026-10-01T15:30:00Z")), false);
  assert.equal(isUrgentAlertTime(new Date("2026-12-01T15:30:00Z")), true);  // EST
  assert.equal(isUrgentAlertTime(new Date("2026-12-01T14:30:00Z")), false);
  assert.equal(isUrgentAlertTime(new Date("2026-10-03T14:30:00Z")), false); // Saturday
  const sells = [
    { ticker: "AAA", shares_to_sell: 10, exit_trigger: 2, urgent: true, deadline: null, note: "Closed 9.80 at or below the stop 10.00." },
    { ticker: "BBB", shares_to_sell: 5, exit_trigger: 3, urgent: false, deadline: null, note: null },
  ];
  assert.deepEqual(formatUrgentPush(sells), { title: "Momentum: 1 urgent sell still open", body: "SELL AAA 10 sh: Stop hit — Closed 9.80 at or below the stop 10.00." });
  assert.equal(formatUrgentPush([sells[1]]), null);
  assert.equal(gtcNeedsUpdate({ disaster_stop: 101.9, disaster_posted: 100 }), false);
  assert.equal(gtcNeedsUpdate({ disaster_stop: 102, disaster_posted: 100 }), true);
  assert.equal(gtcNeedsUpdate({ disaster_stop: 90, disaster_posted: null }), true);
  assert.deepEqual(gtcLines([{ ticker: "AAA", disaster_stop: 102.5, disaster_posted: 100 }, { ticker: "BBB", disaster_stop: 50, disaster_posted: 49.9 }]), ["Update GTC stop AAA → 102.50"]);
});

test("14. equity journal: value, benchmarks from the same start, after-tax, trailing returns, kill switch", () => {
  const cfg = MOM_DEFAULTS;
  const r0 = equityRow({ d: "2025-10-01", b: 20_000, open: [], closed: [], spy: 500, mtum: 200, m: 1, first: null, cfg });
  assert.deepEqual([r0.strategy_value, r0.spy_value, r0.mtum_value, r0.cash], [20_000, 20_000, 20_000, 20_000]);
  const r1 = equityRow({
    d: "2026-03-02", b: 20_000, spy: 550, mtum: 230, m: 0.8, cfg,
    open: [{ shares: 10, fill_price: 100, close: 130, lt_date: "2026-12-01" }],
    closed: [{ pnl: 500, term: "ST", exit_date: "2026-02-01", exit_price: 150, shares: 10, r_multiple: 2.5, days_held: 40 }],
    first: { strategy_value: 20_000, spy: 500, mtum: 200 },
  });
  // open 1300 + realized 500 + cash (20000 − 1000) = 20800
  assert.equal(r1.strategy_value, 20_800);
  assert.equal(r1.spy_value, 22_000);
  assert.equal(r1.mtum_value, 23_000);
  assert.equal(r1.realized_st_ytd, 500);
  // tax: 500 × 0.30 realized ST + 300 × 0.30 unrealized ST
  assert.ok(Math.abs(r1.tax_est - 240) < 1e-9);
  assert.equal(r1.after_tax_value, 20_560);
  const rows: EquityRow[] = [r0, { ...r1, d: "2026-10-01", after_tax_value: 21_000, mtum_value: 24_000 }];
  assert.ok(Math.abs(trailingReturn(rows, 12, "after_tax_value")! - 0.05) < 1e-9);
  assert.equal(trailingReturn([r1], 12, "after_tax_value"), null); // not 12 months of history yet
  const k = killSwitch(rows);
  assert.equal(k.active, true); // +5% after tax vs MTUM +20%
  assert.equal(killSwitch([r0]).active, false);
  const st = tradeStats([{ pnl: 500, term: "ST", exit_date: "2026-09-01", exit_price: 150, shares: 10, r_multiple: 2.5, days_held: 40 },
    { pnl: -100, term: "ST", exit_date: "2026-09-10", exit_price: 90, shares: 10, r_multiple: -1, days_held: 10 }], rows, "2026-10-01");
  assert.deepEqual([st.winRate, st.avgR, st.avgDaysHeld], [0.5, 0.75, 25]);
  assert.match(monthEndLines({ kill: k, idle: 0, cashEtf: "SGOV" })[0], /Kill switch: .*trails MTUM.*ETF version/);
});

test("15. idle cash: under half of I invested → suggest the cash ETF", () => {
  assert.equal(idleCash(5_000, 19_600), 14_600);
  assert.equal(idleCash(12_000, 19_600), 0);
  assert.equal(MOM_DEFAULTS.cash_etf, "SGOV");
  assert.deepEqual(monthEndLines({ kill: { active: false, mine: null, mtum: null }, idle: 14_600, cashEtf: "SGOV" }),
    ["Idle cash $14,600: park it in SGOV or confirm the broker cash sweep."]);
});

test("16. fundamentals: a missing market cap never nulls the stored one; TTM sums need four quarters", () => {
  assert.equal("market_cap" in tickerPatch({ sic_code: "2834" }), false);
  assert.equal("market_cap" in tickerPatch({ market_cap: null }), false);
  assert.equal(tickerPatch({ market_cap: 5e9 }).market_cap, 5e9);
  assert.equal(sum4([{ revenue: 1 }, { revenue: 2 }, { revenue: 3 }, { revenue: 4 }, { revenue: 9 }], "revenue"), 10);
  assert.equal(sum4([{ revenue: 1 }, { revenue: 2 }, { revenue: 3 }], "revenue"), null);
});

function manualBase(): ManualCheck {
  return {
    holding: false, inUniverse: true, entryOk: true, riskOn: true, rebalanceDay: false, heldCount: 5, N: 13, I: 19_600,
    sector: "Energy", sectorNamesAfter: 2, sectorDollarsAfter: 3000, shares: 56, price: 21.12, D: 2.35, target: 1189, valueBefore: 0,
  };
}
