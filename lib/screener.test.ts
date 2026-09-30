import { test } from "node:test";
import assert from "node:assert/strict";
import { emaSeries, smaSeries, wilderRsi } from "./indicators.ts";
import { applyFilters, cleanFilters, dbConditions, earningsStatus, earningsWithin, pullbackConfirmation, reversalPattern, supportTest, tradingDaysBetween, type ScreenerRow } from "./screen.ts";
import { evaluateRules, type AlertRule } from "./alerts.ts";

test("ema/sma", () => {
  const v = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(smaSeries(v, 3), [null, null, 2, 3, 4, 5]);
  const e = emaSeries(v, 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 4*0.5 + 2*0.5
});

const row = (o: Partial<ScreenerRow>): ScreenerRow => ({
  ticker: "F", name: "Ford", type: "CS", exchange: "XNYS", sector: "Consumer Discretionary", industry: null,
  market_cap: 4e10, in_sp500: true, as_of: "2026-09-28", close: 11, change_pct: 1, gap_pct: 0.5,
  volume: 5e7, avg_vol20: 4e7, vol_ratio: 1.25, sma20: 10.5, sma50: 10.2, sma200: 10.4, sma50_prev: 10.1, sma200_prev: 10.4,
  ema9: 10.8, ema21: 10.6, rsi14: 58, atr14: 0.3, hv30: 0.28, high_52w: 12, low_52w: 8.5, pct_from_high: -8.3, pct_from_low: 29,
  pe: 7, ps: 0.2, pb: 1, eps_ttm: 1.5, revenue_ttm: 1.8e11, revenue_growth_yoy: 4, gross_margin: 8, operating_margin: 3,
  net_margin: 2.5, roe: 10, debt_to_equity: 5, current_ratio: 1.1, free_cash_flow_ttm: null, dividend_yield: null,
  next_earnings_date: null,
  vwap: 10.9, range_pos: 60, change_5d: 1, change_20d: 3, nr7: false, inside_day: false,
  day_open: 10.8, day_high: 11.2, day_low: 10.7, sma10: 11.3, prev_open: 11.1, prev_close: 10.9,
  ema20: 10.9, ema20_5d: 10.8, swing_low5: 10.6, swing_high20: 12.2, resistance60: 11.5, rsi_min5: 45, ...o,
});

test("filters", () => {
  const rows = [row({}), row({ ticker: "X", close: 60 }), row({ ticker: "Y", close: 20, sma200: 25 })];
  const f = cleanFilters({ close_max: "50", above_sma200: "1", bogus: "1" });
  assert.deepEqual(Object.keys(f).sort(), ["above_sma200", "close_max"]);
  assert.equal(cleanFilters({ side: "short" }).side, "short"); // side survives (applied from trade plans in the page)
  assert.deepEqual(applyFilters(rows, f).map((r) => r.ticker), ["F"]);
  assert.deepEqual(applyFilters(rows, { rsi14_min: "50" }).map((r) => r.ticker).sort(), ["F", "X", "Y"]);
  assert.deepEqual(applyFilters(rows, { rsi14_min: "60" }), []);
  // Options filters are gone with the wheel: they're dropped like any unknown key.
  assert.deepEqual(cleanFilters({ put_annual_yield_min: "20", has_put: "1" }), {});
});

test("alerts", () => {
  const rules: AlertRule[] = [
    { id: 1, name: "cross", kind: "golden_cross", ticker: null, screen_id: null, watchlist_id: 7, params: {}, enabled: true },
    { id: 2, name: "above", kind: "price_above", ticker: "F", screen_id: null, watchlist_id: null, params: { price: 10 }, enabled: true },
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

  assert.equal(levelsFor("wheel", base), null); // the wheel preset is gone

  const over = levelsFor("oversold", base)!; // SMA10 11.3 above close → target the 10-day average
  assert.equal(over.target, 11.3);

  // Missing data → no plan instead of a bogus one.
  assert.equal(levelsFor("orb", row({ ...base, day_high: null })), null);
  assert.equal(levelsFor("vwap", row({ ...base, atr14: null })), null);
  assert.equal(levelsFor("unknown", base), null);
  // ATR ≈ 79% of price (a pump-and-dump microcap) is over the 12% ATR limit → no plan.
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

  // Settings: bad or out-of-range input falls back to the defaults.
  const s = normalizeSizing({ account: "250000", riskPct: "abc", maxAdvPct: "-1", dayTradeLeverage: 4 });
  assert.deepEqual(s, { ...DEFAULT_SIZING, account: 250000 });
  assert.equal(sizePosition(long, row({ avg_vol20: 1e8 }), false, s)!.qty, 5000); // $2,500 ÷ $0.50

  // Max $ per position: $30,000 ÷ $20 = 1,500 sh, below the 2,400 the $1,200 risk would allow.
  const capped = sizePosition(long, row({ avg_vol20: 1e8 }), false, normalizeSizing({ maxPosition: "30000" }))!;
  assert.deepEqual([capped.qty, capped.position, capped.risk, capped.cap], [1500, 30000, 750, "max position"]);
  // 0 (or blank) means no cap; negative input falls back to the default (no cap).
  assert.equal(normalizeSizing({ maxPosition: "0" }).maxPosition, 0);
  assert.equal(normalizeSizing({ maxPosition: "-5" }).maxPosition, 0);
});

test("Wilder RSI matches the database's exact recursive aggregate", () => {
  // Same 21-point series run through ss_wilder_rsi() in Postgres → 67.2549240241038
  const xs = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 10 + i * 0.25 : 10 + i * 0.25 - 0.75));
  assert.ok(Math.abs(wilderRsi(xs)! - 67.2549240241038) < 1e-9);
  assert.equal(wilderRsi([1, 2, 3]), null); // needs 14 changes
  assert.equal(wilderRsi(Array.from({ length: 20 }, (_, i) => i)), 100); // only gains
  assert.equal(wilderRsi(Array.from({ length: 20 }, () => 5)), 50); // flat
});

test("reversal candles", () => {
  // ELVN 2026-09-25: open 45.54, high 45.77, low 44.175, close 44.75 — red, small lower wick → none.
  const elvn = row({ day_open: 45.54, day_high: 45.77, day_low: 44.175, close: 44.75, prev_open: 45.9, prev_close: 45.17 });
  assert.equal(reversalPattern(elvn), null);
  assert.equal(reversalPattern(row({ day_open: 10, close: 10.2, day_high: 10.3, day_low: 9.9, prev_open: 10.5, prev_close: 10.3 })), "green");
  // Bullish engulfing: prior red 10.5→10.1, today opens 10.0 (≤ 10.1) and closes 10.6 (≥ 10.5).
  assert.equal(reversalPattern(row({ prev_open: 10.5, prev_close: 10.1, day_open: 10.0, close: 10.6, day_high: 10.7, day_low: 9.95 })), "engulfing");
  // Red hammer: body 0.05, lower wick 0.60, upper wick 0.02, close in the top of the range.
  assert.equal(reversalPattern(row({ day_open: 10.0, close: 9.95, day_high: 10.02, day_low: 9.35, prev_open: 10.4, prev_close: 10.1 })), "hammer");
});

test("earnings within N trading days", () => {
  assert.equal(tradingDaysBetween("2026-09-25", "2026-10-02"), 5); // Fri → next Fri
  assert.equal(tradingDaysBetween("2026-09-25", "2026-09-28"), 1); // weekend skipped
  const r = (d: string | null) => row({ as_of: "2026-09-25", next_earnings_date: d });
  assert.equal(earningsWithin(r("2026-10-02"), 5), true);
  assert.equal(earningsWithin(r("2026-10-05"), 5), false);
  assert.equal(earningsStatus(r(null)), "unknown");
  assert.deepEqual(applyFilters([r("2026-09-30"), r(null)], { no_earnings_5d: "1" }).map((x) => x.next_earnings_date), [null]);
});

test("market regime gate", async () => {
  const { STRATEGY_BY_KEY, strategyGate } = await import("./strategies.ts");
  const over = STRATEGY_BY_KEY.get("oversold")!;
  assert.equal(strategyGate(over, null).ok, false); // unknown regime blocks
  assert.equal(strategyGate(over, { ticker: "SPY", close: 500, sma200: 520, as_of: "2026-09-25" }).ok, false);
  assert.equal(strategyGate(over, { ticker: "SPY", close: 560, sma200: 520, as_of: "2026-09-25" }).ok, true);
  assert.equal(strategyGate(STRATEGY_BY_KEY.get("orb")!, null).ok, true); // strategies without the rule aren't gated
});

test("oversold plan + sizing: ELVN 2026-09-25 with $120k", async () => {
  const { levelsFor } = await import("./levels.ts");
  const { sizePosition, normalizeSizing } = await import("./sizing.ts");
  const { STRATEGY_BY_KEY } = await import("./strategies.ts");
  const elvn = row({
    ticker: "ELVN", as_of: "2026-09-25", close: 44.75, atr14: 2.25286, sma10: 48.967, sma20: 53.4315,
    avg_vol20: 1_423_300, day_open: 45.54, day_high: 45.77, day_low: 44.175,
  });
  const l = levelsFor("oversold", elvn)!;
  assert.deepEqual(
    [l.entry, l.stop, l.target, l.openRange, l.rr, l.rrWorst, l.sizingRisk, l.timeExit],
    [44.75, 41.37, 48.97, { low: 42.5, high: 45.88 }, 1.2, 0.7, 4.51, { days: 5, date: "2026-10-02" }],
  );
  const s = normalizeSizing({ account: 120000, riskPct: 1, maxAdvPct: 1 });
  const z = sizePosition(l, elvn, true, s, STRATEGY_BY_KEY.get("oversold")!.sizing)!;
  // $600 ÷ $4.51 worst-case risk = 133 sh; 15% cap = $18,000 ÷ 45.88 = 392; 0.10% ADV = 1,423.
  assert.deepEqual([z.qty, z.cap, Math.round(z.position), Math.round(z.risk), Math.round(z.reward)], [133, "risk", 6102, 600, 561]);
  assert.deepEqual([z.used!.riskPct, z.used!.maxPositionPct, z.used!.maxAdvPct], [0.5, 15, 0.1]);
});

test("strategy overrides only tighten", async () => {
  const { applyOverrides, normalizeSizing } = await import("./sizing.ts");
  const s = normalizeSizing({ riskPct: 0.25, maxAdvPct: 2, maxPositionPct: 10 });
  const t = applyOverrides(s, { riskPct: 0.5, maxAdvPct: 0.1, maxPositionPct: 15 });
  assert.deepEqual([t.riskPct, t.maxAdvPct, t.maxPositionPct], [0.25, 0.1, 10]); // user's tighter values win
  assert.equal(applyOverrides(normalizeSizing({}), { maxPositionPct: 15 }).maxPositionPct, 15); // 0 = off → strategy cap applies
});

test("ATR% limit replaces the 20% stop rule", async () => {
  const { levelsFor } = await import("./levels.ts");
  const ok = row({ close: 10, atr14: 1.1, day_high: 10.3, day_low: 9.6, vwap: 10.1, sma10: 11 }); // 11%
  const wild = row({ close: 10, atr14: 1.3, day_high: 10.3, day_low: 9.6, vwap: 10.1, sma10: 11 }); // 13%
  assert.ok(levelsFor("oversold", ok));
  assert.equal(levelsFor("oversold", wild), null);
  assert.equal(levelsFor("orb", wild), null);
});

// Real rows from the 2026-09-25 snapshot.
const GRDN = {
  ticker: "GRDN", as_of: "2026-09-25", close: 41.21, avg_vol20: 699_839, vol_ratio: 1.02969, sma50: 40.7866, sma200: 36.8559,
  rsi14: 45.6614, atr14: 1.98213, day_open: 41.7, day_high: 42.34, day_low: 41.19, prev_open: 43.09, prev_close: 41.79,
  ema20: 42.6965, ema20_5d: 42.6027, swing_low5: 41.19, swing_high20: 48.33, resistance60: 47.02,
};
const LILAK = {
  ticker: "LILAK", close: 8.49, atr14: 0.272786, day_open: 8.53, day_high: 8.605, day_low: 8.42, prev_open: 8.44, prev_close: 8.55,
  sma50: 8.3216, ema20: 8.56363, ema20_5d: 8.55229, swing_low5: 8.34, swing_high20: 8.915, resistance60: 8.8394,
};

test("pullback: support test and confirmation", () => {
  // GRDN's low 41.19 is within 0.25 ATR (0.50) of the 50 SMA (40.79) and it closed above it.
  assert.equal(supportTest(row(GRDN)), "SMA 50");
  // LILAK's close 8.49 didn't hold the 20 EMA zone (8.5636 − 0.068), but its 5-day low 8.34
  // tested the 50 SMA (8.32 + 0.068) and it closed above it → SMA 50 support.
  assert.equal(supportTest(row(LILAK)), "SMA 50");
  assert.equal(supportTest(row({ ...LILAK, swing_low5: 8.42 })), null); // low never reached either level
  // Breakout-level retest counts only if the stock broke above it in the last 20 days.
  const retest = row({ close: 50.3, atr14: 1, day_low: 49.9, swing_low5: 49.9, ema20: 53, sma50: 45, resistance60: 50, swing_high20: 55 });
  assert.equal(supportTest(retest), "breakout level");
  assert.equal(supportTest(row({ ...retest, swing_high20: 49 })), null);

  assert.equal(pullbackConfirmation(row(GRDN)), null); // red candle near its low
  // Green candle that dipped below the 20 EMA (10.9) and closed back above it.
  assert.equal(pullbackConfirmation(row({ day_open: 10.8, day_low: 10.75, close: 11.05, day_high: 11.3, ema20: 10.9, prev_open: 10.9, prev_close: 11.0 })), "EMA 20 reclaim");
  // Green but never touched the EMA → not a reclaim.
  assert.equal(pullbackConfirmation(row({ day_open: 11.0, day_low: 10.95, close: 11.2, day_high: 11.4, ema20: 10.9, prev_open: 11.3, prev_close: 11.1 })), null);
});

test("pullback plan + sizing: GRDN 2026-09-25 with $120k", async () => {
  const { levelsFor } = await import("./levels.ts");
  const { sizePosition, normalizeSizing } = await import("./sizing.ts");
  const { STRATEGY_BY_KEY, meetsMinRR } = await import("./strategies.ts");
  const pb = STRATEGY_BY_KEY.get("pullback")!;
  const l = levelsFor("pullback", row(GRDN))!;
  assert.deepEqual(
    [l.entry, l.limit, l.stop, l.target, l.rr, l.rrWorst, l.sizingRisk, l.scaleOutPct, l.trail],
    [42.35, 42.85, 40.2, 48.33, 2.8, 2.1, 2.65, 50, { label: "EMA 20", value: 42.7 }],
  );
  assert.equal(meetsMinRR(pb, l), true);
  const z = sizePosition(l, row(GRDN), true, normalizeSizing({ account: 120000 }), pb.sizing)!;
  // $1,200 ÷ $2.65 (limit − stop) = 452 sh; position at the limit = $19,368; 50% at T1 = 226 × $5.98.
  assert.deepEqual([z.qty, Math.round(z.position), Math.round(z.risk), Math.round(z.reward), z.cap], [452, 19368, 1198, 1351, "risk"]);
  // Risk is capped at 1% even if the user's setting is higher; a lower user setting wins.
  assert.equal(sizePosition(l, row(GRDN), true, normalizeSizing({ account: 120000, riskPct: 2 }), pb.sizing)!.qty, 452);
  assert.equal(sizePosition(l, row(GRDN), true, normalizeSizing({ account: 120000, riskPct: 0.5 }), pb.sizing)!.qty, 226);

  // LILAK: T1 8.91 vs buy-stop 8.62 and stop 8.20 → 0.7R → hidden by the 2:1 rule.
  const lil = levelsFor("pullback", row(LILAK))!;
  assert.equal(lil.rr, 0.7);
  assert.equal(meetsMinRR(pb, lil), false);
  assert.equal(meetsMinRR(STRATEGY_BY_KEY.get("orb")!, lil), true); // no minimum on other strategies
});

test("pullback preset filters: trend stack and slope", () => {
  const up = row({ close: 45, sma50: 40, sma200: 35, ema20: 44, ema20_5d: 43 });
  assert.deepEqual(applyFilters([up], { ema20_above_sma50: "1", ema20_rising: "1" }).length, 1);
  assert.deepEqual(applyFilters([row({ ...up, ema20_5d: 44.5 })], { ema20_rising: "1" }).length, 0); // falling EMA
  assert.deepEqual(applyFilters([row({ ...up, ema20: 39 })], { ema20_above_sma50: "1" }).length, 0); // not stacked
});

test("screen alerts respect a strategy's regime gate and 2:1 rule", async () => {
  const { evaluateRules } = await import("./alerts.ts");
  // GRDN with a hammer at the 20 EMA (passes every pullback rule, 2.4R) and LILAK with a reclaim (0.7R).
  const grdn = row({ ...GRDN, close: 42.1, day_open: 41.8, day_low: 40.9, ema20: 42.0, ema20_5d: 41.6, swing_low5: 40.9, rsi14: 47.2, rsi_min5: 44, vol_ratio: 1.29, avg_vol20: 699_839 });
  const lil = row({ ...LILAK, close: 8.6, day_open: 8.5, day_low: 8.5, day_high: 8.62, rsi14: 49.4, rsi_min5: 46, vol_ratio: 1.8, avg_vol20: 1_305_800, sma200: 7.5 });
  const { STRATEGY_BY_KEY, strategyQuery } = await import("./strategies.ts");
  const f = Object.fromEntries(new URLSearchParams(strategyQuery(STRATEGY_BY_KEY.get("pullback")!)));
  const rule = { id: 9, name: "Pullback", kind: "screen_match" as const, ticker: null, screen_id: 1, watchlist_id: null, params: {}, enabled: true };
  const ctx = (close: number) => ({ watchlists: new Map(), screens: new Map([[1, f]]), regime: { ticker: "SPY", close, sma200: 700, as_of: "2026-09-25" } });
  assert.deepEqual(evaluateRules([rule], [grdn, lil], ctx(770)).map((h) => h.ticker), ["GRDN"]); // LILAK < 2:1 → no alert
  assert.deepEqual(evaluateRules([rule], [grdn, lil], ctx(650)), []); // SPY below its 200-day → no alerts
});

test("pullback logic fixes: multi-day test, RSI over the pullback, reclaim, ETFs", async () => {
  // 1) Support tested earlier in the pullback: today's low (42.6) is above the zone, but the
  //    5-day low (41.0) touched the 20 EMA (41.2 ± 0.5) and today's close holds above it.
  const earlier = row({ close: 43.1, atr14: 2, day_low: 42.6, swing_low5: 41.0, ema20: 41.2, sma50: 38, resistance60: 50, swing_high20: 47 });
  assert.equal(supportTest(earlier), "EMA 20");
  assert.equal(supportTest(row({ ...earlier, swing_low5: 42.6 })), null); // never came down to it

  // 2) RSI rule uses the lowest RSI of the pullback: RSI 55 today after a strong candle still qualifies
  //    if it dipped to 44 during the pullback; one that dipped to 35 "broke down" and doesn't.
  const f = { rsi_min5_min: "40", rsi_min5_max: "50" };
  assert.equal(applyFilters([row({ rsi14: 55, rsi_min5: 44 })], f).length, 1);
  assert.equal(applyFilters([row({ rsi14: 55, rsi_min5: 35 })], f).length, 0);
  assert.equal(applyFilters([row({ rsi14: 47, rsi_min5: 52 })], f).length, 0); // never cooled into 40–50

  // 3) Reclaim after closing below the EMA yesterday, even if today's low stayed above it.
  assert.equal(pullbackConfirmation(row({ prev_close: 10.8, prev_open: 10.85, day_open: 10.95, day_low: 10.92, close: 11.1, day_high: 11.2, ema20: 10.9 })), "EMA 20 reclaim");
  // Green but was never below the EMA (and not an engulfing: prior day was green) → not a reclaim.
  assert.equal(pullbackConfirmation(row({ prev_close: 11.0, prev_open: 10.9, day_open: 10.95, day_low: 10.92, close: 11.1, day_high: 11.2, ema20: 10.9 })), null);

  // 4) ETFs excluded, ADRs kept.
  const rows = [row({ ticker: "SSO", type: "ETF" }), row({ ticker: "UGP", type: "ADRC" }), row({ ticker: "U", type: "CS" })];
  assert.deepEqual(applyFilters(rows, { exclude_etfs: "1", sort: "ticker", dir: "asc" }).map((r) => r.ticker), ["U", "UGP"]);
});

test("dbConditions pushes only plain column filters", () => {
  const c = dbConditions({ close_min: "5", rsi14_max: "30", atr_pct_max: "12", gap_abs_min: "2", sector: "Energy", sp500: "1", q: "AA", exclude_etfs: "1" });
  assert.deepEqual(c, [
    { op: "gte", col: "close", value: 5 },
    { op: "lte", col: "rsi14", value: 30 },
    { op: "eq", col: "sector", value: "Energy" },
    { op: "eq", col: "in_sp500", value: true },
  ]);
});
