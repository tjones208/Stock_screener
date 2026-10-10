import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBacktest, runBacktestMany, type StrategyDef } from "../src/engine/engine.ts";
import { percentile, runBatch } from "../src/batch.ts";
import { rsRsi2 } from "../src/strategies/signals.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

/** Seeded random market with frequent RSI(2) dips, so signals often outnumber the slots. */
function market(seed = 11, n = 40, len = 420) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const days = weekdays("2016-01-01", len), rows = [];
  for (const t of ["SPY", ...Array.from({ length: n }, (_, k) => `T${k}`)]) {
    let c = 40 + rnd() * 40;
    const drift = t === "SPY" ? 0.0006 : 0.0004 + rnd() * 0.0015, vol = t === "SPY" ? 0.008 : 0.012 + rnd() * 0.02;
    for (const d of days) {
      const o = c * (1 + (rnd() - 0.5) * vol * 0.4), nc = o * (1 + drift + (rnd() - 0.5) * vol * 2);
      rows.push({ ...row(t, d, o, nc), h: Math.max(o, nc) * (1 + rnd() * vol * 0.5), l: Math.min(o, nc) * (1 - rnd() * vol * 0.5), dv: nc * 1e6 });
      c = nc;
    }
  }
  return { src: new MemorySource(rows), days };
}
const def = rsRsi2 as unknown as StrategyDef;
const base = { min_price: 1, sizing: "equal", max_positions: 3, max_hold_days: 10, stop_atr: null, disaster_stop_pct: 0.2, rank_by: "random" };

test("percentile: linear interpolation like numpy", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.05), 1.2);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 0.95)! - 4.8) < 1e-12);
  assert.equal(percentile([], 0.5), null);
});

test("runBacktestMany: identical to separate runs; seeds replay exactly and differ from each other", async () => {
  const { src, days } = market();
  const opt = { from: days[260], to: days.at(-1)!, capital: 25_000, slippageBps: 10 };
  const items = [
    { def, params: { ...base, seed: 1 } }, { def, params: { ...base, seed: 2 } },
    { def, params: { ...base, seed: 1, max_atr_pct: 0.03 } }, { def, params: { ...base, rank_by: "rs" } },
  ];
  const many = await runBacktestMany(src, items, opt);
  for (const [k, it] of items.entries()) {
    const one = await runBacktest(src, it.def, it.params, opt);
    assert.deepEqual(many[k].equity.map((e) => e.equity), one.equity.map((e) => e.equity), `run ${k}`);
    assert.deepEqual(many[k].fills, one.fills);
  }
  const again = await runBacktest(src, def, { ...base, seed: 1 }, opt);
  assert.deepEqual(again.fills, many[0].fills);
  assert.notDeepEqual(many[0].fills.map((f) => f.ticker), many[1].fills.map((f) => f.ticker), "different seeds pick different names");
  assert.ok(many[0].fills.length > 20);
});

test("Monte Carlo batch: groups × seeds in one pass, percentile summary and per-seed CSV", async () => {
  const { src, days } = market();
  const out = mkdtempSync(join(tmpdir(), "bt-mc-"));
  const logs: string[] = [];
  const r = await runBatch(src, {
    name: "mc", from: days[260], to: days.at(-1)!, capital: 25_000, slippageBps: 10, bench: ["SPY"],
    montecarlo: { seeds: { from: 1, to: 5 }, groups: [
      { strategy: "rs_rsi2", label: "A", params: base },
      { strategy: "rs_rsi2", label: "B", params: { ...base, max_atr_pct: 0.03 } },
    ] },
  }, out, (e) => { if (e.type === "log") logs.push(e.text); });
  assert.equal(r.rows.length, 10);
  const sum = readFileSync(join(r.dir, "montecarlo-mc.csv"), "utf8").trim().split("\n");
  assert.equal(sum.length, 3);
  assert.match(sum[0], /^config,seeds,cagr_p5,cagr_median,cagr_p95,max_drawdown_p5,.*,end_value_p95,pct_beat_benchmark,benchmark,benchmark_cagr$/);
  const a = sum[1].split(",");
  assert.equal(a[0], '"A"'); assert.equal(a[1], "5");
  const cagrs = r.rows.filter((x) => x.label.startsWith("A ")).map((x) => x.stats.cagr);
  assert.ok(Math.abs(Number(a[3]) - percentile(cagrs, 0.5)!) < 1e-6);
  const spy = r.bench.SPY.cagr;
  assert.ok(Math.abs(Number(a[11]) - cagrs.filter((c) => c > spy).length / 5) < 1e-9);
  assert.equal(readFileSync(join(r.dir, "montecarlo-mc-runs.csv"), "utf8").trim().split("\n").length, 11);
  assert.ok(logs.some((l) => /^A: CAGR .* seeds beat SPY/.test(l)));
});

test("grid batch: every combination in one pass, per-run rows and a median / beat summary", async () => {
  const { src, days } = market();
  const out = mkdtempSync(join(tmpdir(), "bt-grid-"));
  const r = await runBatch(src, {
    name: "nb", from: days[260], to: days.at(-1)!, capital: 25_000, slippageBps: 10, bench: ["SPY"],
    grid: { strategy: "rs_rsi2", params: { ...base, rank_by: "rs" }, axes: { max_positions: [2, 3], max_atr_pct: [null, 0.03] }, beat: 0.05, output: "neighborhood" },
  }, out);
  assert.equal(r.rows.length, 4);
  const lines = readFileSync(join(r.dir, "neighborhood-nb.csv"), "utf8").trim().split("\n");
  assert.equal(lines[0], "run,max_positions,max_atr_pct,cagr,max_drawdown,end_value,trades,avg_sessions_held,time_stop_exits,time_stop_avg_sessions,time_stop_min_sessions,time_stop_max_sessions");
  assert.match(lines[1], /^max_positions=2 max_atr_pct=null,2,null,/);
  assert.match(lines[4], /^max_positions=3 max_atr_pct=0\.03,3,0\.03,/);
  const cagrs = r.rows.map((x) => x.stats.cagr);
  const med = Number(lines.find((l) => l.startsWith("median_cagr,"))!.split(",")[1]);
  assert.ok(Math.abs(med - percentile(cagrs, 0.5)!) < 1e-6);
  assert.equal(lines.find((l) => l.startsWith("runs_with_cagr_above_5pct,")), `runs_with_cagr_above_5pct,${cagrs.filter((c) => c > 0.05).length}`);
  // Same results as running one combination alone.
  const one = await runBacktest(src, def, { ...base, rank_by: "rs", max_positions: 3, max_atr_pct: 0.03 }, { from: days[260], to: days.at(-1)!, capital: 25_000, slippageBps: 10 });
  assert.equal(r.rows[3].stats.endValue, one.equity.at(-1)!.equity);
});

test("batch folders: plain short names; a folder that can't be written doesn't lose the summary", async () => {
  const { src, days } = market();
  const out = mkdtempSync(join(tmpdir(), "bt-names-"));
  const logs: string[] = [];
  const r = await runBatch(src, {
    name: "nb", from: days[260], to: days.at(-1)!, capital: 25_000, slippageBps: 10, bench: [],
    grid: { strategy: "rs_rsi2", params: { ...base, rank_by: "rs" }, axes: { max_positions: [2, 3], max_atr_pct: [null, 0.035] }, output: "neighborhood" },
  }, out, (e) => { if (e.type === "log") logs.push(e.text); });
  for (const row of r.rows) assert.match(row.folder, /^run-\d{3}-[A-Za-z0-9_-]{1,40}$/, row.folder);
  assert.equal(r.rows[3].folder, "run-004-max_positions_3_max_atr_pct_0_035");
  // Block one run folder with a file of the same name: the batch still finishes and logs it.
  const { writeFileSync, existsSync } = await import("node:fs");
  const out2 = mkdtempSync(join(tmpdir(), "bt-block-"));
  const orig = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { return "2030-01-01T00:00:00.000Z"; };
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(out2, "2030-01-01T00-00-00-nb"), { recursive: true });
    writeFileSync(join(out2, "2030-01-01T00-00-00-nb", "run-001-max_positions_2_max_atr_pct_null"), "not a folder");
    const logs2: string[] = [];
    const r2 = await runBatch(src, {
      name: "nb", from: days[260], to: days.at(-1)!, capital: 25_000, slippageBps: 10, bench: [],
      grid: { strategy: "rs_rsi2", params: { ...base, rank_by: "rs" }, axes: { max_positions: [2, 3] , max_atr_pct: [null] }, output: "neighborhood" },
    }, out2, (e) => { if (e.type === "log") logs2.push(e.text); });
    assert.ok(existsSync(join(r2.dir, "neighborhood-nb.csv")));
    assert.ok(logs2.some((l) => /Couldn't write the folder .*run-001/.test(l)));
    assert.ok(logs2.some((l) => /1 of 2 run folders couldn't be written/.test(l)));
    assert.ok(existsSync(join(r2.dir, "run-002-max_positions_3_max_atr_pct_null", "trades.csv")));
  } finally {
    Date.prototype.toISOString = orig;
  }
});

test("max_hold_days: every time-stop exit is exactly max_hold_days sessions after entry, for each value", async () => {
  const { src, days } = market();
  const out = mkdtempSync(join(tmpdir(), "bt-hold-"));
  const r = await runBatch(src, {
    name: "h", from: days[260], to: days.at(-1)!, capital: 25_000, slippageBps: 10, bench: [],
    grid: { strategy: "rs_rsi2", params: { ...base, rank_by: "rs", max_positions: 8 }, axes: { max_hold_days: [5, 10, 15] }, output: "holdcheck" },
  }, out);
  for (const [k, n] of [5, 10, 15].entries()) {
    const h = (r.rows[k] as unknown as { holds: import("../src/batch.ts").HoldStats }).holds;
    assert.ok(h.timeStops > 0, `hold ${n}: some time stops`);
    assert.deepEqual([h.timeStopMin, h.timeStopMax], [n, n], `hold ${n}`);
    assert.ok(h.avgSessions! <= n);
  }
  // Longer holds → fewer trades (slots turn over less often).
  const trades = r.rows.map((x) => (x as unknown as { holds: import("../src/batch.ts").HoldStats }).holds.trades);
  assert.ok(trades[0] > trades[1] && trades[1] > trades[2]);
});
