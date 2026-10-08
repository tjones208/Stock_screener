import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest, type StrategyDef } from "../src/engine/engine.ts";
import { pullback } from "../src/strategies/pullback.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

const bar = (d: string, o: number, h: number, l: number, c: number) => ({ ...row("A", d, o, c), h, l });

/** Buys A at the first open with stop 95 / target 110, then keeps both working every day. */
async function bracket(bars: ReturnType<typeof bar>[]) {
  const def: StrategyDef = {
    name: "t", description: "", defaults: {}, warmupDays: 0,
    create: () => ({
      onClose: (ctx) => ctx.i === 0
        ? [{ side: "buy", ticker: "A", shares: 10, exits: () => ({ stop: 95, target: 110 }) }]
        : [{ side: "sell", ticker: "A", shares: "all", stop: 95, target: 110 }],
    }),
  };
  const days = bars.map((b) => b.d);
  return runBacktest(new MemorySource(bars), def, {}, { from: days[0], to: days.at(-1)!, capital: 10_000 });
}

test("engine: stop and target orders (gaps, same-day bracket, stop first, expiry)", async () => {
  const d = weekdays("2024-01-01", 4);
  const sell = async (b: ReturnType<typeof bar>[]) => (await bracket(b)).fills.find((f) => f.side === "sell");
  // Bought at 100; the same day trades down to 94: stopped at 95 (no gap rule on the entry day).
  let f = await sell([bar(d[0], 100, 100, 100, 100), bar(d[1], 100, 101, 94, 96)]);
  assert.deepEqual([f?.d, f?.price, f?.tag], [d[1], 95, "stop"]);
  // Held overnight, opens at 90 under the stop: sold at the open.
  f = await sell([bar(d[0], 100, 100, 100, 100), bar(d[1], 100, 102, 99, 101), bar(d[2], 90, 92, 88, 91)]);
  assert.deepEqual([f?.d, f?.price, f?.tag], [d[2], 90, "stop_gap"]);
  // Opens at 112 over the target: sold at the open.
  f = await sell([bar(d[0], 100, 100, 100, 100), bar(d[1], 100, 102, 99, 101), bar(d[2], 112, 113, 111, 112)]);
  assert.deepEqual([f?.d, f?.price, f?.tag], [d[2], 112, "target_gap"]);
  // Both levels trade the same day: the stop is assumed first.
  f = await sell([bar(d[0], 100, 100, 100, 100), bar(d[1], 100, 102, 99, 101), bar(d[2], 101, 111, 94, 105)]);
  assert.deepEqual([f?.price, f?.tag], [95, "stop"]);
  // Target only.
  f = await sell([bar(d[0], 100, 100, 100, 100), bar(d[1], 100, 102, 99, 101), bar(d[2], 101, 111, 100, 105)]);
  assert.deepEqual([f?.price, f?.tag], [110, "target"]);
  // Neither: the orders lapse each day and the position stays open.
  const r = await bracket([bar(d[0], 100, 100, 100, 100), bar(d[1], 100, 102, 99, 101), bar(d[2], 101, 105, 97, 103), bar(d[3], 103, 104, 102, 103)]);
  assert.equal(r.fills.filter((x) => x.side === "sell").length, 0);
  assert.equal(r.open[0].shares, 10);
  assert.equal(r.unfilled, 0);
});

/** Random-walk universe (seeded) plus SPY. */
function universe(seed: number, n = 30, len = 500) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const days = weekdays("2015-01-01", len);
  const rows = [];
  for (const t of ["SPY", ...Array.from({ length: n }, (_, k) => `T${k}`)]) {
    const drift = t === "SPY" ? 0.0004 : (rnd() - 0.4) * 0.003, vol = t === "SPY" ? 0.01 : 0.015 + rnd() * 0.02;
    let c = 50 + rnd() * 50;
    for (const d of days) {
      const o = c * (1 + gauss() * vol * 0.3), nc = o * (1 + drift + gauss() * vol);
      rows.push({ ...row(t, d, o, nc), h: Math.max(o, nc) * (1 + rnd() * vol * 0.6), l: Math.min(o, nc) * (1 - rnd() * vol * 0.6), v: 1e6, dv: nc * 1e6 });
      c = nc;
    }
  }
  return { src: new MemorySource(rows), days };
}

test("pullback: position caps, exit reasons, no doubling up", async () => {
  const { src, days } = universe(42);
  const p = pullback.defaults;
  const r = await runBacktest(src, pullback as unknown as StrategyDef, { min_price: 1 }, { from: days[0], to: days.at(-1)!, capital: 125_000, slippageBps: 5 });
  const buys = r.fills.filter((f) => f.side === "buy");
  assert.ok(buys.length > 50, `expected trades, got ${buys.length}`);
  const eqBefore = new Map(r.equity.map((e, i) => [e.d, r.equity[i - 1]?.equity ?? 125_000]));
  for (const b of buys) {
    assert.ok(b.shares * b.price <= p.max_position_pct * eqBefore.get(b.d)! + 1e-6, `position cap ${b.ticker} ${b.d}`);
  }
  assert.ok(Math.max(...r.equity.map((e) => e.positions)) <= p.max_positions);
  const tags = new Set(r.closed.map((c) => c.exitTag));
  for (const t of tags) assert.ok(["stop", "stop_gap", "target", "target_gap", "close_below_ma", "time_stop"].includes(t!), `tag ${t}`);
  assert.ok(tags.has("stop") && tags.has("target") && tags.has("close_below_ma"));
  // A closed trade's loss never exceeds its 0.75% risk budget by more than a gap through the stop allows.
  for (const c of r.closed.filter((x) => x.exitTag === "stop")) assert.ok(-c.pnl <= p.risk_per_trade * 125_000 * 3, `${c.ticker} ${c.pnl}`);
  // Never two lots of the same ticker at once.
  for (const e of new Set(r.open.map((l) => l.ticker))) assert.equal(r.open.filter((l) => l.ticker === e).length, 1);
  assert.ok(r.closed.every((c) => c.days <= p.max_hold_days * 1.6 + 3));
});

test("pullback: the market filter blocks entries while SPY is under its 200-day average", async () => {
  const { src, days } = universe(7);
  const on = await runBacktest(src, pullback as unknown as StrategyDef, { min_price: 1 }, { from: days[0], to: days.at(-1)!, capital: 125_000 });
  const off = await runBacktest(src, pullback as unknown as StrategyDef, { min_price: 1, use_market_filter: false }, { from: days[0], to: days.at(-1)!, capital: 125_000 });
  assert.ok(off.fills.length >= on.fills.length);
  // No entry can come before SPY has 200 bars of history.
  assert.ok(on.fills.filter((f) => f.side === "buy").every((f) => f.d > days[200]));
});
