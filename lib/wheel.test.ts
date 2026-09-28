import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOcc, rankPuts, scorePut, type RawPut } from "./wheel.ts";
import { emaSeries, smaSeries } from "./indicators.ts";
import { applyFilters, cleanFilters, type ScreenerRow } from "./screen.ts";
import { evaluateRules, type AlertRule } from "./alerts.ts";

test("parseOcc", () => {
  assert.deepEqual(parseOcc("F251121P00010500"), { root: "F", expiration: "2025-11-21", side: "put", strike: 10.5 });
  assert.equal(parseOcc("garbage"), null);
});

const put = (o: Partial<RawPut>): RawPut => ({
  contract: "SOFI261030P00015000", ticker: "SOFI", expiration: "2026-10-30", strike: 15, underlying: 16.5,
  bid: 0.4, ask: 0.46, last: 0.43, iv: 0.62, delta: -0.24, theta: -0.01, openInterest: 1200, volume: 0, ...o,
});

test("rankPuts filters and scores", () => {
  const ranked = rankPuts([
    put({}),
    put({ contract: "A", strike: 60, underlying: 61 }), // collateral > $5k
    put({ contract: "B", delta: -0.5 }), // too much delta
    put({ contract: "C", bid: 0.1, ask: 0.5 }), // spread too wide
    put({ contract: "D", expiration: "2026-10-05" }), // DTE < 14
    put({ contract: "E", openInterest: 5 }), // illiquid
  ], "2026-09-28");
  assert.equal(ranked.length, 1);
  const p = ranked[0];
  assert.equal(p.dte, 32);
  assert.ok(Math.abs(p.mid - 0.43) < 1e-9);
  assert.ok(Math.abs(p.annualYield - (0.43 / 15) * (365 / 32)) < 1e-9);
  assert.ok(p.score > 0 && p.score <= 100);
});

test("score prefers higher yield, all else equal", () => {
  const base = { iv: 0.5, delta: -0.2, openInterest: 500, spreadPct: 0.1 };
  assert.ok(scorePut({ ...base, annualYield: 0.4 }) > scorePut({ ...base, annualYield: 0.2 }));
  assert.ok(scorePut({ ...base, annualYield: 0.3, delta: -0.15 }) > scorePut({ ...base, annualYield: 0.3, delta: -0.3 }));
});

test("ema/sma", () => {
  const v = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(smaSeries(v, 3), [null, null, 2, 3, 4, 5]);
  const e = emaSeries(v, 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 4*0.5 + 2*0.5
});

const row = (o: Partial<ScreenerRow>): ScreenerRow => ({
  ticker: "F", name: "Ford", type: "CS", exchange: "XNYS", sector: "Consumer Discretionary", industry: null,
  market_cap: 4e10, in_sp500: true, has_options: true, as_of: "2026-09-28", close: 11, change_pct: 1, gap_pct: 0.5,
  volume: 5e7, avg_vol20: 4e7, vol_ratio: 1.25, sma20: 10.5, sma50: 10.2, sma200: 10.4, sma50_prev: 10.1, sma200_prev: 10.4,
  ema9: 10.8, ema21: 10.6, rsi14: 58, atr14: 0.3, hv30: 0.28, high_52w: 12, low_52w: 8.5, pct_from_high: -8.3, pct_from_low: 29,
  pe: 7, ps: 0.2, pb: 1, eps_ttm: 1.5, revenue_ttm: 1.8e11, revenue_growth_yoy: 4, gross_margin: 8, operating_margin: 3,
  net_margin: 2.5, roe: 10, debt_to_equity: 5, current_ratio: 1.1, free_cash_flow_ttm: null, dividend_yield: null,
  next_earnings_date: null, put_contract: "F261030P00010000", put_expiration: "2026-10-30", put_dte: 32, put_strike: 10,
  put_mid: 0.2, put_iv: 0.35, put_delta: -0.22, put_oi: 5000, put_spread_pct: 0.05, put_annual_yield: 0.23, wheel_score: 40, ...o,
});

test("filters", () => {
  const rows = [row({}), row({ ticker: "X", close: 60 }), row({ ticker: "Y", close: 20, sma200: 25 })];
  const f = cleanFilters({ close_max: "50", above_sma200: "1", bogus: "1" });
  assert.deepEqual(Object.keys(f).sort(), ["above_sma200", "close_max"]);
  assert.deepEqual(applyFilters(rows, f).map((r) => r.ticker), ["F"]);
  assert.deepEqual(applyFilters(rows, { put_annual_yield_min: "20" }).map((r) => r.ticker).sort(), ["F", "X", "Y"]);
  assert.deepEqual(applyFilters(rows, { put_annual_yield_min: "30" }), []);
  assert.deepEqual(applyFilters(rows, { put_delta_max: "0.2" }), []); // abs(-0.22) > 0.2
});

test("alerts", () => {
  const rules: AlertRule[] = [
    { id: 1, name: "cross", kind: "golden_cross", ticker: null, screen_id: null, watchlist_id: 7, params: {}, enabled: true },
    { id: 2, name: "yield", kind: "wheel_yield", ticker: "F", screen_id: null, watchlist_id: null, params: { min_yield: 20 }, enabled: true },
    { id: 3, name: "rsi", kind: "rsi_below", ticker: "F", screen_id: null, watchlist_id: null, params: { value: 30 }, enabled: true },
  ];
  const rows = [row({ sma50: 10.5, sma50_prev: 10.3 }), row({ ticker: "G", sma50: 10.5, sma50_prev: 10.3 })];
  const hits = evaluateRules(rules, rows, { watchlists: new Map([[7, new Set(["G"])]]), screens: new Map() });
  assert.deepEqual(hits.map((h) => `${h.rule_id}:${h.ticker}`), ["1:G", "2:F"]);
});
