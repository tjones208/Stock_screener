import { test } from "node:test";
import assert from "node:assert/strict";
import { entryRange, entryShares, Hist, normalizePb, PB_DEFAULTS, pctRank } from "./core.ts";
import { exitStatus, pbEquity, pushText, type Bars, type PbTrade } from "./live.ts";

const p = PB_DEFAULTS;
const cal = { traded: ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"], holidays: new Set<string>() };

test("normalizePb: settings JSON → params, bad values fall back", () => {
  const n = normalizePb({ max_positions: "6", risk_per_trade: "x", common_only: "on", rs_universe: "all", junk: 1 });
  assert.equal(n.max_positions, 6);
  assert.equal(n.risk_per_trade, PB_DEFAULTS.risk_per_trade);
  assert.equal(n.common_only, true);
  assert.equal(n.rs_universe, "all");
  assert.equal("junk" in n, false);
});

test("pctRank matches pandas rank(pct=True) with ties averaged", () => {
  const s = [1, 2, 2, 3];
  assert.deepEqual([1, 2, 3].map((x) => pctRank(s, x)), [0.25, 0.625, 1]);
});

test("entryShares: risk budget, position cap, stop band, slots, heat", () => {
  const o = { price: 100, stop: 95, equity: 100_000, openHeat: 0, openCount: 0 };
  // risk 750 / 5 = 150 shares; position cap 20% = 200 shares.
  assert.equal(entryShares(o, p), 150);
  assert.equal(entryShares({ ...o, stop: 99 }, p), 0);           // 1% stop: too tight
  assert.equal(entryShares({ ...o, stop: 85 }, p), 0);           // 15% stop: too wide
  assert.equal(entryShares({ ...o, openCount: 8 }, p), 0);       // no slot
  assert.equal(entryShares({ ...o, openHeat: 4_000 }, p), 0);    // 4,000 + 750 > 4.5% of 100k
  assert.equal(entryShares({ ...o, stop: 97 }, p), 200);         // 750 / 3 = 250, capped at 20% = 200
  const r = entryRange(95, p);
  assert.ok(Math.abs(r.min - 95 / 0.98) < 1e-9 && Math.abs(r.max - 95 / 0.9) < 1e-9);
});

const bars = (closes: number[], last?: Partial<{ h: number; l: number }>): Bars => {
  const d = cal.traded.slice(-closes.length);
  return { ticker: "A", d, o: closes, h: closes.map((c, i) => (i === closes.length - 1 && last?.h) || c + 0.5), l: closes.map((c, i) => (i === closes.length - 1 && last?.l) || c - 0.5), c: closes, v: closes.map(() => 1e6) };
};
const trade: PbTrade = { id: 1, ticker: "A", signal_d: null, entry_d: "2026-10-02", entry: 100, shares: 10, stop: 95, target: 110, exit_d: null, exit: null, exit_reason: null, note: null };

test("exitStatus: stop, target, fast-MA close, time stop, hold", () => {
  const q = { ...p, fast_ma: 3, max_hold_days: 4 };
  assert.equal(exitStatus(trade, bars([100, 101, 102, 103], { l: 94 }), cal, q).reason, "stop");
  assert.equal(exitStatus(trade, bars([100, 101, 102, 103], { h: 111 }), cal, q).reason, "target");
  assert.equal(exitStatus(trade, bars([104, 105, 106, 101]), cal, q).reason, "close_below_ma");
  // Held 2026-10-02 → 10-07 = 4 sessions: time stop.
  assert.equal(exitStatus(trade, bars([100, 101, 102, 103]), cal, q).reason, "time_stop");
  const h = exitStatus(trade, bars([100, 101, 102]), cal, { ...q, max_hold_days: 15 });
  assert.deepEqual([h.action, h.held], ["HOLD", 4]);
  assert.equal(exitStatus({ ...trade, entry_d: "2026-10-08" }, bars([100, 101, 102]), cal, q).action, "HOLD");
  assert.equal(exitStatus(trade, undefined, cal, q).action, "NO DATA");
});

test("pbEquity adds P&L closed since the account value was set; pushText only when there's news", () => {
  const s = { params: p, account_value: 20_000, account_set_at: "2026-10-05" };
  const closed = [{ ...trade, exit_d: "2026-10-06", exit: 105 }, { ...trade, id: 2, exit_d: "2026-10-01", exit: 90 }];
  assert.equal(pbEquity(s, closed), 20_050);
  assert.equal(pbEquity({ ...s, account_value: null }, closed), null);
  assert.equal(pushText({ trade_d: "2026-10-08", buys: [], exits: [] }), null);
  const m = pushText({
    trade_d: "2026-10-08",
    buys: [{ ticker: "B", rs: 0.9, close: 50, stop: 47, target: 56, stop_pct: 0.06, shares: 40, risk: 120, value: 2000, entry_min: 47.96, entry_max: 52.22, skip: null }],
    exits: [{ ...exitStatus(trade, bars([100, 101, 102, 103], { l: 94 }), cal, { ...p, fast_ma: 3 }) }],
  })!;
  assert.match(m.title, /1 buy, 1 exit for Thu/);
  assert.match(m.body, /SELL A: Stop traded\nBUY B 40 sh, stop 47.00, target 56.00/);
});

test("Hist: rolling averages and pullback flags", () => {
  const h = new Hist({ ...p, fast_ma: 3, pullback_window: 2, min_down_days: 2 }, 10);
  for (const c of [10, 11, 12, 11, 10, 12]) h.push({ c, h: c + 0.2, l: c - 0.2, dv: c * 1e6 });
  assert.ok(Math.abs(h.maFast - 11) < 1e-12);
  assert.equal(h.pullback(), true);   // two down closes ending yesterday
  assert.equal(h.confirm(), true);    // 12 > yesterday's high 10.2
});
