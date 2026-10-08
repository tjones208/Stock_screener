import { test } from "node:test";
import assert from "node:assert/strict";
import type { StrategyDef } from "../src/engine/engine.ts";
import { runBacktest } from "../src/engine/engine.ts";
import { runStudy } from "../src/study.ts";
import { breakout, rsi2, rsLeaders, Tape } from "../src/strategies/signals.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

test("Tape: Wilder RSI(2), means and highs", () => {
  const t = new Tape(10, 2);
  for (const c of [10, 11, 10.5, 9.5, 9]) t.push({ c, v: c * 100, dv: c * 1000 });
  // Changes +1, −0.5 seed the averages (gain 0.5, loss 0.25), then −1 and −0.5 are smoothed with n = 2.
  let g = 0.5, l = 0.25;
  g = (g * 1 + 0) / 2; l = (l * 1 + 1) / 2;
  g = (g * 1 + 0) / 2; l = (l * 1 + 0.5) / 2;
  assert.ok(Math.abs(t.rsi - (100 - 100 / (1 + g / l))) < 1e-12);
  assert.equal(t.maxClose(3), 10.5);
  assert.equal(t.mean("v", 2, 1), (950 + 1050) / 2); // the two bars before today
  assert.ok(Number.isNaN(t.mean("c", 6)));
});

const D = weekdays("2018-01-01", 330);
/** SPY steady uptrend; liquid stock U trending; X set up per test on the last days. */
function market(x: (i: number) => { c: number; v?: number }) {
  const rows = [];
  for (const [i, d] of D.entries()) {
    rows.push({ ...row("SPY", d, 100 + i * 0.1, 100 + i * 0.1), dv: 1e12 });
    rows.push({ ...row("U", d, 50 + i * 0.05, 50 + i * 0.05), v: 1e6, dv: 1e9 });
    const { c, v = 1e6 } = x(i);
    rows.push({ ...row("X", d, c, c), v, dv: c * v });
  }
  return new MemorySource(rows);
}
const signalDays = async (def: StrategyDef, src: MemorySource, params: Record<string, unknown> = {}) => {
  const days: string[] = [];
  const wrapped: StrategyDef = { ...def, create: (p, env) => { const s = def.create(p, env); return { ...s, onClose: (ctx) => { const o = s.onClose(ctx); if (o.some((x) => x.side === "buy" && x.ticker === "X")) days.push(ctx.d); return o; } }; } };
  await runStudy(src, wrapped, { strategy: def.name, params, from: D[260], to: D[320], horizons: [1] });
  return days;
};

test("breakout: new 50-day closing high on 1.5× volume in an uptrend", async () => {
  // X rises slowly (50 > 200 MA), then on day 300 makes a new high: with 2× volume (signal) and day 310 with 1.2× (none).
  const src = market((i) => ({ c: 30 + i * 0.02 + (i === 300 || i === 310 ? 2 : 0), v: i === 300 ? 2e6 : i === 310 ? 1.2e6 : 1e6 }));
  const days = await signalDays(breakout as unknown as StrategyDef, src);
  assert.ok(days.includes(D[300]));
  assert.ok(!days.includes(D[310]));
});

test("rsi2: two sharp down days above the 200-day average", async () => {
  const src = market((i) => ({ c: 40 + i * 0.05 - (i === 300 ? 1 : i === 301 ? 2.5 : 0) }));
  const days = await signalDays(rsi2 as unknown as StrategyDef, src);
  assert.ok(days.includes(D[301]));
  assert.ok(days.every((d) => d >= D[300] && d <= D[302]));
  assert.deepEqual(rsi2.studyHorizons, [3, 5, 10, 15]);
});

test("rs_leaders: top decile by 126→21-day return, first session of each week only", async () => {
  const rows = [];
  for (const [i, d] of D.entries()) {
    rows.push({ ...row("SPY", d, 100 + i * 0.1, 100 + i * 0.1), dv: 1e12 });
    for (let k = 0; k < 20; k++) { const c = 20 * (1 + (k / 2000) * i); rows.push({ ...row(`S${k}`, d, c, c), dv: 1e9 }); }
  }
  const days: { d: string; t: string[] }[] = [];
  const def = rsLeaders as unknown as StrategyDef;
  const wrapped: StrategyDef = { ...def, create: (p, env) => { const s = def.create(p, env); return { ...s, onClose: (ctx) => { const o = s.onClose(ctx); const t = o.filter((x) => x.side === "buy").map((x) => x.ticker); if (t.length) days.push({ d: ctx.d, t }); return o; } }; } };
  await runStudy(new MemorySource(rows), wrapped, { strategy: "rs_leaders", from: D[260], to: D[320], horizons: [1] });
  assert.ok(days.length >= 10);
  for (const x of days) {
    assert.equal(new Date(x.d + "T00:00:00Z").getUTCDay(), 1, `${x.d} is a Monday (no holidays in the test calendar)`);
    assert.deepEqual(x.t, ["S19", "S18"]); // top 10% of 20
  }
});

test("signal strategies run as backtests: equal weight, sold after hold_days", async () => {
  const src = market((i) => ({ c: 40 + i * 0.05 - (i % 25 === 0 ? 1.5 : i % 25 === 1 ? 2 : 0) }));
  const r = await runBacktest(src, rsi2 as unknown as StrategyDef, { hold_days: 3 }, { from: D[220], to: D[329], capital: 10_000 });
  const sells = r.fills.filter((f) => f.side === "sell" && f.tag === "time");
  assert.ok(sells.length >= 2);
  for (const c of r.closed) assert.equal(c.days >= 3 && c.days <= 5, true, `${c.entryD} → ${c.exitD}`);
});
