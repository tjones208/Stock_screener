import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest, type StrategyDef } from "../src/engine/engine.ts";
import { rsRsi2, Tape } from "../src/strategies/signals.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

const D = weekdays("2018-01-01", 340);
const def = rsRsi2 as unknown as StrategyDef;
// RSI(2) on day 301: 6.25 for X's dip, 3.44 for Y's (both under 10 only on day 301); the 200-day average stays below.
const dipX = (i: number) => (i === 300 ? 0.5 : i === 301 ? 0.7 : 0);
const dipY = (i: number) => (i === 300 ? 0.4 : i === 301 ? 0.9 : 0);

/** SPY up; 8 weak fillers; X strongest (wide ±1 daily ranges, so ATR ≈ 2); optional Y second strongest. */
function market(o: { crashX?: number; withY?: boolean; dropCloseX?: [number, number] } = {}) {
  const rows = [];
  for (const [i, d] of D.entries()) {
    rows.push({ ...row("SPY", d, 100 + i * 0.1, 100 + i * 0.1), dv: 1e12 });
    for (let k = 0; k < 8; k++) { const c = 50 + i * 0.01; rows.push({ ...row(`F${k}`, d, c, c), dv: 1e9 }); }
    const cx = (40 + i * 0.05 - dipX(i)) * (o.dropCloseX && i === o.dropCloseX[0] ? 1 - o.dropCloseX[1] : 1);
    rows.push({ ...row("X", d, cx, cx), h: cx + 1, l: i === o.crashX ? cx - 30 : cx - 1, dv: 1e9 });
    if (o.withY) { const cy = 40 + i * 0.045 - dipY(i); rows.push({ ...row("Y", d, cy, cy), h: cy + 1, l: cy - 1, dv: 1e9 }); }
  }
  return new MemorySource(rows);
}
const run = (src: MemorySource, params: Record<string, unknown> = {}) =>
  runBacktest(src, def, params, { from: D[260], to: D[339], capital: 100_000, slippageBps: 0 });

/** ATR(14) of X at the close of day `i`, the way the strategy computes it. */
function atrX(i: number) {
  const t = new Tape(30);
  for (let k = 0; k <= i; k++) { const c = 40 + k * 0.05 - dipX(k); t.push({ c, v: 1e6, dv: 1e9, h: c + 1, l: c - 1 }); }
  return t.atr(14);
}

test("rs_rsi2: next-open entry sized on 3 × ATR risk, stop worked intraday", async () => {
  const r = await run(market({ crashX: 310 }));
  const buy = r.fills.find((f) => f.side === "buy" && f.ticker === "X")!;
  assert.equal(buy.d, D[302]);                                      // signal on day 301's close
  const dist = 3 * atrX(301), entry = 40 + 302 * 0.05;
  assert.equal(buy.price, entry);
  assert.equal(buy.shares, Math.min(Math.floor((100_000 * 0.0075) / dist), Math.floor(20_000 / entry)));
  const exit = r.closed.find((c) => c.ticker === "X")!;
  assert.deepEqual([exit.exitD, exit.exitTag], [D[310], "stop"]);
  assert.ok(Math.abs(exit.exit - (entry - dist)) < 1e-9);
});

test("rs_rsi2: time exit after max_hold_days; stop_atr null keeps the size and drops the stop", async () => {
  const t = await run(market(), { max_hold_days: 5 });
  const x = t.closed.find((c) => c.ticker === "X")!;
  assert.deepEqual([x.entryD, x.exitD, x.exitTag], [D[302], D[307], "time_stop"]); // 5 closes held, sold at the 6th open
  const noStop = await run(market({ crashX: 310 }), { stop_atr: "null" });
  const withStop = await run(market({ crashX: 310 }));
  const a = noStop.closed.find((c) => c.ticker === "X")!, b = withStop.closed.find((c) => c.ticker === "X")!;
  assert.equal(a.shares, b.shares);
  assert.deepEqual([a.exitTag, a.exitD], ["time_stop", D[322]]); // default 20 sessions; the crash day didn't stop it out
});

test("rs_rsi2: a target only with reward_risk; rank_by picks between signals for the last slot", async () => {
  const tg = await run(market(), { reward_risk: 0.1 });
  assert.equal(tg.closed.find((c) => c.ticker === "X")!.exitTag, "target");
  const byRs = await run(market({ withY: true }), { max_positions: 1 });
  const byRsi = await run(market({ withY: true }), { max_positions: 1, rank_by: "rsi2" });
  const first = (r: Awaited<ReturnType<typeof run>>) => r.fills.find((f) => f.side === "buy")!.ticker;
  assert.equal(first(byRs), "X");   // stronger 126→21-day return
  assert.equal(first(byRsi), "Y");  // lower RSI(2)
  assert.equal(byRs.fills.filter((f) => f.side === "buy" && f.d === D[302]).length, 1);
});

test("rs_rsi2 sizing=equal: equity ÷ max_positions in whole shares, no heat cap; disaster stop on the close", async () => {
  const entry = 40 + 302 * 0.05;
  const eq8 = await run(market(), { sizing: "equal", stop_atr: null });
  assert.equal(eq8.fills.find((f) => f.side === "buy" && f.ticker === "X")!.shares, Math.floor(100_000 / 8 / entry));
  const eq5 = await run(market(), { sizing: "equal", stop_atr: null, max_positions: 5, max_portfolio_heat: 0 });
  assert.equal(eq5.fills.find((f) => f.side === "buy" && f.ticker === "X")!.shares, Math.floor(100_000 / 5 / entry)); // heat cap ignored
  const riskZeroHeat = await run(market(), { max_portfolio_heat: 0 });
  assert.equal(riskZeroHeat.fills.filter((f) => f.side === "buy").length, 0); // …but it binds risk sizing
  // A close 25% under the entry on day 310 with a 20% disaster stop: sold at day 311's open.
  const ds = await run(market({ dropCloseX: [310, 0.25] }), { sizing: "equal", stop_atr: null, disaster_stop_pct: 0.2 });
  const x = ds.closed.find((c) => c.ticker === "X")!;
  assert.deepEqual([x.exitD, x.exitTag], [D[311], "disaster_stop"]);
  const ds30 = await run(market({ dropCloseX: [310, 0.25] }), { sizing: "equal", stop_atr: null, disaster_stop_pct: 0.3 });
  assert.equal(ds30.closed.find((c) => c.ticker === "X")!.exitTag, "time_stop");
});
