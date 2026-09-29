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
