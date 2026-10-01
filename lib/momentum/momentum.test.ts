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
  const s = positionShares(round2(T0), 85.46, round2(D), cfg);
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

test("ticket retries: same cap, day-3 reset or drop, drop after 5 sessions", () => {
  const cfg = MOM_DEFAULTS;
  const t0: TicketState = { status: "open", retry_day: 1, trade_date: "2026-10-01", s_close: 50, cap: 51.5 };
  const d2 = advanceTicket(t0, "2026-10-02", { entry_ok: true, close: 55 }, cfg);
  assert.deepEqual([d2.retry_day, d2.cap, d2.trade_date, d2.promote], [2, 51.5, "2026-10-02", false]);
  const d3 = advanceTicket(d2, "2026-10-05", { entry_ok: true, close: 55 }, cfg);
  assert.deepEqual([d3.retry_day, d3.s_close, d3.cap, d3.status], [3, 55, 56.65, "open"]);
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
