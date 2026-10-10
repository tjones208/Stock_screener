import { test } from "node:test";
import assert from "node:assert/strict";
import type { StrategyDef } from "../src/engine/engine.ts";
import { runBacktest } from "../src/engine/engine.ts";
import { runStudy } from "../src/study.ts";
import { breakout, etfRsi2, gapDrift, lcReversal, rsi2, rsi2Deep, rsLeaders, rsRsi2, Tape } from "../src/strategies/signals.ts";
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

test("rsi2_deep needs RSI(2) under 5; rs_rsi2 also needs the top 20% by 126→21-day return", async () => {
  // X: a gentle uptrend with a mild 2-day dip (RSI between 5 and 10) on days 300–301 and a hard one on 320–321.
  const dip = (i: number) => (i === 300 ? 0.5 : i === 301 ? 0.7 : i === 320 ? 2 : i === 321 ? 3 : 0); // RSI 6.25 on 301; 2.5 and 1.28 on 320–321
  const src = market((i) => ({ c: 40 + i * 0.05 - dip(i) }));
  const mild = await signalDays(rsi2 as unknown as StrategyDef, src);
  const deep = await signalDays(rsi2Deep as unknown as StrategyDef, src);
  assert.ok(deep.length > 0 && deep.every((d) => mild.includes(d)), "deep signals are a subset of rsi2");
  assert.ok(deep.length < mild.length);
  assert.deepEqual(rsi2Deep.studyHorizons, [3, 5, 10, 15]);
  // Among SPY's peers only U and X are liquid stocks: X's 126→21 return (≈+0.13%/day) tops U's, so X is in the top 20%.
  const rs = await signalDays(rsRsi2 as unknown as StrategyDef, src);
  assert.deepEqual(rs, mild);
  // Make X the laggard: no rs_rsi2 signals at all.
  const lag = market((i) => ({ c: 80 - i * 0.01 + (i > 250 ? (i - 250) * 0.06 : 0) - dip(i) }));
  assert.ok((await signalDays(rsi2 as unknown as StrategyDef, lag)).length > 0);
  assert.deepEqual(await signalDays(rsRsi2 as unknown as StrategyDef, lag), []);
  assert.deepEqual(rsLeaders.studyHorizons, [10, 20, 40, 60]);
});

/** Days each ticker signals, and the universe on each signal day, from a study-style run. */
async function signalsOf(def: StrategyDef, rows: ReturnType<typeof row>[], params: Record<string, unknown>, from: string, to: string) {
  const out: { d: string; t: string[]; uni: string[] }[] = [];
  const wrapped: StrategyDef = { ...def, create: (p, env) => { const s = def.create(p, env); return { ...s, onClose: (ctx) => {
    const o = s.onClose(ctx), t = o.filter((x) => x.side === "buy").map((x) => x.ticker);
    if (t.length) out.push({ d: ctx.d, t, uni: s.universe!(ctx) });
    return o;
  } }; } };
  await runStudy(new MemorySource(rows), wrapped, { strategy: def.name, params, from, to, horizons: [1] });
  return out;
}

test("gap_drift: ≥5% gap up on ≥3× volume, closing in the top half of the range", async () => {
  const D2 = weekdays("2018-01-01", 120), rows = [];
  for (const [i, d] of D2.entries()) {
    const c = 20;
    // Day 100: gap 6%, volume 4×, close near the high → signal. Day 105: same gap, closes at the low → no.
    // Day 110: gap 4% → no. Day 115: gap 6% but volume 2× → no.
    if (i === 100) rows.push({ ...row("G", d, 21.2, 21.8), h: 22, l: 21, v: 4e6, dv: 1e9 });
    else if (i === 105) rows.push({ ...row("G", d, 21.2, 21), h: 22, l: 21, v: 4e6, dv: 1e9 });
    else if (i === 110) rows.push({ ...row("G", d, 20.8, 21.5), h: 21.6, l: 20.7, v: 4e6, dv: 1e9 });
    else if (i === 115) rows.push({ ...row("G", d, 21.2, 21.8), h: 22, l: 21, v: 2e6, dv: 1e9 });
    else rows.push({ ...row("G", d, c, c), h: c, l: c, v: 1e6, dv: 1e9 });
  }
  const s = await signalsOf(gapDrift as unknown as StrategyDef, rows, {}, D2[60], D2[119]);
  assert.deepEqual(s.map((x) => x.d), [D2[100]]);
  assert.deepEqual(gapDrift.studyHorizons, [5, 10, 20, 40]);
});

test("etf_rsi2: only the listed ETFs (SPY included) form the universe; RSI(2) < 10 above the 200-day", async () => {
  const D2 = weekdays("2018-01-01", 320), rows = [];
  for (const [i, d] of D2.entries()) {
    for (const t of ["SPY", "XLK", "AAPL"]) {
      const c = 100 + i * 0.1 - (t === "XLK" && i === 300 ? 1 : t === "XLK" && i === 301 ? 1.5 : 0); // XLK: RSI(2) 5.6 on day 301
      rows.push({ ...row(t, d, c, c), dv: 1e9 });
    }
  }
  const s = await signalsOf(etfRsi2 as unknown as StrategyDef, rows, {}, D2[260], D2[319]);
  assert.ok(s.length >= 1 && s.every((x) => x.t.every((t) => t === "XLK")));
  assert.deepEqual(s[0].uni.sort(), ["SPY", "XLK"]);
});

test("lc_reversal: bottom 5% by 5-day return among the top N by 50-day dollar volume, above the 200-day", async () => {
  const D2 = weekdays("2018-01-01", 320), rows = [];
  for (const [i, d] of D2.entries()) {
    for (let k = 0; k < 30; k++) {
      // K0 has the most dollar volume and drops 8% over days 296–300; K29 drops the same but is outside the top 20.
      const drop = (k === 0 || k === 29) && i >= 296 && i <= 300 ? 1 - 0.016 * (i - 295) : 1;
      const c = (50 + i * 0.2) * drop; // a strong trend keeps the −8% dip above the 200-day average
      rows.push({ ...row(`K${k}`, d, c, c), dv: (30 - k) * 1e8 });
    }
  }
  const s = await signalsOf(lcReversal as unknown as StrategyDef, rows, { top_n: 20 }, D2[260], D2[319]);
  assert.ok(s.some((x) => x.d === D2[300] && x.t.includes("K0")));
  assert.ok(s.every((x) => !x.t.includes("K29")));
  assert.equal(s[0].uni.length, 20);
  assert.ok(!s[0].uni.includes("K29"));
});
