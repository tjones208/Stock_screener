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
  put_mid: 0.2, put_iv: 0.35, put_delta: -0.22, put_oi: 5000, put_spread_pct: 0.05, put_annual_yield: 0.23, wheel_score: 40,
  vwap: 10.9, range_pos: 60, change_5d: 1, change_20d: 3, nr7: false, inside_day: false,
  day_open: 10.8, day_high: 11.2, day_low: 10.7, ...o,
});

test("filters", () => {
  const rows = [row({}), row({ ticker: "X", close: 60 }), row({ ticker: "Y", close: 20, sma200: 25 })];
  const f = cleanFilters({ close_max: "50", above_sma200: "1", bogus: "1" });
  assert.deepEqual(Object.keys(f).sort(), ["above_sma200", "close_max"]);
  assert.equal(cleanFilters({ side: "short" }).side, "short"); // side survives (applied from trade plans in the page)
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

test("strategy presets only use known filters and columns", async () => {
  const { STRATEGIES } = await import("./strategies.ts");
  const keys = new Set<string>();
  for (const s of STRATEGIES) {
    assert.ok(!keys.has(s.key), `duplicate key ${s.key}`);
    keys.add(s.key);
    // cleanFilters drops anything it doesn't recognise, so a typo would silently vanish.
    assert.deepEqual(cleanFilters({ strategy: s.key, ...s.filters }), { strategy: s.key, ...s.filters }, s.key);
  }
});

test("derived filters: ATR%, $ volume, vs VWAP, sort by derived", () => {
  const a = row({ ticker: "A", close: 20, atr14: 1, avg_vol20: 3e6, vwap: 19 });   // ATR 5%, $60M, +5.3% vs VWAP
  const b = row({ ticker: "B", close: 50, atr14: 0.5, avg_vol20: 1e6, vwap: 51 }); // ATR 1%, $50M, −2% vs VWAP
  assert.deepEqual(applyFilters([a, b], { atr_pct_min: "2" }).map((r) => r.ticker), ["A"]);
  assert.deepEqual(applyFilters([a, b], { dollar_vol_min: "55000000" }).map((r) => r.ticker), ["A"]);
  assert.deepEqual(applyFilters([a, b], { pct_from_vwap_max: "0" }).map((r) => r.ticker), ["B"]);
  assert.deepEqual(applyFilters([a, b], { sort: "atr_pct", dir: "asc" }).map((r) => r.ticker), ["B", "A"]);
  assert.deepEqual(applyFilters([a, b], { nr7: "1" }), []);
  assert.deepEqual(applyFilters([a, row({ ticker: "C", nr7: true })], { nr7: "1" }).map((r) => r.ticker), ["C"]);
});

test("strategy levels", async () => {
  const { levelsFor } = await import("./levels.ts");
  const { STRATEGIES } = await import("./strategies.ts");
  const base = row({ close: 11, atr14: 0.4, day_high: 11.2, day_low: 10.7, vwap: 10.9, sma20: 11.5, high_52w: 12 });

  // Every strategy yields a plan for a normal row, with stop and target on the correct sides.
  for (const s of STRATEGIES) {
    const l = levelsFor(s.key, base);
    assert.ok(l, s.key);
    if (l.side === "Long") assert.ok(l.stop < l.entry && l.entry < l.target, s.key);
    if (l.side === "Short") assert.ok(l.stop > l.entry && l.entry > l.target, s.key);
  }

  const orb = levelsFor("orb", base)!; // closed at 60% of range → long break of the high
  assert.deepEqual([orb.side, orb.entry, orb.stop, orb.target, orb.rr], ["Long", 11.21, 11.01, 11.61, 2]);

  const vwapShort = levelsFor("vwap", base)!; // closed above VWAP → short the stretch
  assert.deepEqual([vwapShort.side, vwapShort.entry, vwapShort.stop, vwapShort.target], ["Short", 11.2, 11.4, 10.9]);
  const vwapLong = levelsFor("vwap", row({ ...base, close: 10.6 }))!;
  assert.deepEqual([vwapLong.side, vwapLong.entry, vwapLong.target], ["Long", 10.6, 10.9]);

  const wheel = levelsFor("wheel", base)!; // strike 10, mid 0.20
  assert.deepEqual([wheel.side, wheel.entry, wheel.stop, wheel.target, wheel.rr], ["Sell put", 0.2, 9.8, 0.1, null]);

  const over = levelsFor("oversold", base)!; // SMA20 11.5 above close → target the average
  assert.equal(over.target, 11.5);

  // Missing data → no plan instead of a bogus one.
  assert.equal(levelsFor("orb", row({ ...base, day_high: null })), null);
  assert.equal(levelsFor("vwap", row({ ...base, atr14: null })), null);
  assert.equal(levelsFor("unknown", base), null);
  // Stop > 20% from entry (ATR ≈ 79% of price, like a pump-and-dump microcap) → no plan.
  assert.equal(levelsFor("orb", row({ ...base, close: 7.7, atr14: 6.07, day_high: 12.1, day_low: 6.8, range_pos: 17 })), null);
});

test("position sizing", async () => {
  const { sizePosition, normalizeSizing, DEFAULT_SIZING } = await import("./sizing.ts");
  const long = { side: "Long" as const, entry: 20, stop: 19.5, target: 21, rr: 2, how: "" };

  // $120k × 1% = $1,200 risk ÷ $0.50/share = 2,400 sh ($48k) — under 4× BP and 1% of 10M ADV.
  const a = sizePosition(long, row({ avg_vol20: 10_000_000 }), false)!;
  assert.deepEqual([a.qty, a.position, a.risk, a.reward, a.cap], [2400, 48000, 1200, 2400, "risk"]);

  // Tight stop: $1,200 ÷ $0.02 = 60,000 sh ($1.2M) → capped by 4× BP ($480k ÷ $20 = 24,000 sh).
  const tight = { ...long, stop: 19.98 };
  assert.equal(sizePosition(tight, row({ avg_vol20: 1e9 }), false)!.cap, "buying power");
  assert.equal(sizePosition(tight, row({ avg_vol20: 1e9 }), false)!.qty, 24000);
  // Overnight (swing) uses 2× → 12,000 sh.
  assert.equal(sizePosition(tight, row({ avg_vol20: 1e9 }), true)!.qty, 12000);

  // Thin stock: 1% of 100k ADV = 1,000 sh.
  const thin = sizePosition(long, row({ avg_vol20: 100_000 }), false)!;
  assert.deepEqual([thin.qty, thin.cap], [1000, "liquidity"]);

  // Shorts size the same way off |entry − stop|.
  const short = { side: "Short" as const, entry: 20, stop: 20.5, target: 19, rr: 2, how: "" };
  assert.equal(sizePosition(short, row({ avg_vol20: 10_000_000 }), false)!.qty, 2400);

  // Wheel: $5,000 ÷ ($10 strike × 100) = 5 contracts; profit at 50% buy-back of a $0.20 credit = $50.
  const put = { side: "Sell put" as const, entry: 0.2, stop: 9.8, target: 0.1, rr: null, how: "" };
  const w = sizePosition(put, row({}), false)!;
  assert.deepEqual([w.qty, w.unit, w.position, Math.round(w.reward)], [5, "ct", 5000, 50]);

  // Settings: bad or out-of-range input falls back to the defaults.
  const s = normalizeSizing({ account: "250000", riskPct: "abc", maxAdvPct: "-1", dayTradeLeverage: 4 });
  assert.deepEqual(s, { ...DEFAULT_SIZING, account: 250000 });
  assert.equal(sizePosition(long, row({ avg_vol20: 1e8 }), false, s)!.qty, 5000); // $2,500 ÷ $0.50
});
