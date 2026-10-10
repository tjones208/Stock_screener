import { test } from "node:test";
import assert from "node:assert/strict";
import { cspCsv, realizedVol, runCsp } from "../src/csp.ts";
import { Tape } from "../src/strategies/signals.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

test("realizedVol: annualized sample stdev of daily log returns", () => {
  const t = new Tape(40);
  const closes = [100, 101, 99, 102, 100, 103];
  for (const c of closes) t.push({ c, v: 1, dv: 1 });
  const r = closes.slice(1).map((c, k) => Math.log(c / closes[k]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  assert.ok(Math.abs(realizedVol(t, 5) - sd * Math.sqrt(252)) < 1e-12);
  assert.ok(Number.isNaN(realizedVol(t, 6)));
});

/** SPY up; 10 strong stocks with daily noise; X has a sharp 2-day dip on day 301 and then falls 30% by day 322. */
function market() {
  const D = weekdays("2018-01-01", 340), rows = [];
  let s = 5;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const [i, d] of D.entries()) {
    rows.push({ ...row("SPY", d, 100 + i * 0.1, 100 + i * 0.1), dv: 1e12 });
    for (let k = 0; k < 10; k++) { const c = (20 + k) * (1 + i * 0.002) * (1 + (rnd() - 0.5) * 0.02); rows.push({ ...row(`S${k}`, d, c, c), h: c * 1.01, l: c * 0.99, dv: 1e9 }); }
    const base = 20 + i * 0.05, dip = i === 300 ? 0.5 : i === 301 ? 0.7 : 0, crash = i > 301 ? Math.min(i - 301, 21) * 0.015 : 0;
    const cx = (base - dip) * (1 - crash);
    rows.push({ ...row("X", d, cx, cx), h: cx * 1.01, l: cx * 0.99, dv: 1e9 });
  }
  return { src: new MemorySource(rows), D };
}

test("runCsp: signal vs baseline entries, strike from 30-day vol, assignment 21 sessions later", async () => {
  const { src, D } = market();
  const res = await runCsp(src, D[280], D[315], { params: { min_price: 1 } });
  const sig = res.rows.find((r) => r.group === "signal" && r.year === "All")!;
  const base = res.rows.find((r) => r.group === "baseline" && r.year === "All")!;
  // X's dip on day 301 is the only rs_rsi2 signal; it then falls ~30% over 21 sessions: assigned, a deep loss.
  const x = res.signalEntries.find((e) => e.t === "X")!;
  assert.equal(x.d, D[301]);
  assert.ok(Math.abs(x.strike - x.close * Math.exp(-0.67 * x.sigma * Math.sqrt(21 / 252))) < 1e-9);
  assert.ok(x.assigned && x.outcome < -0.15 && Math.abs(x.outcome - (x.close_after - x.strike) / x.strike) < 1e-12);
  assert.equal(sig.entries, res.signalEntries.length);
  assert.equal(sig.assignment_rate, res.signalEntries.filter((e) => e.assigned).length / sig.entries);
  // Signal entries respect the $50 price cap.
  assert.ok(res.signalEntries.every((e) => e.close < 50));
  // The baseline is every other day's top-RS names above their 200-day: many entries, none of them the signal.
  assert.ok(base.entries > 30);
  assert.ok(base.assignment_rate! >= 0 && base.assignment_rate! < 0.5);
  assert.equal(res.settings.baseline_max_atr_pct, null); // the signal had no ATR cap here, so neither does the baseline
  // Price cap: nothing qualifies under $10.
  const capped = await runCsp(src, D[280], D[315], { params: { min_price: 1 }, max_price: 10 });
  assert.equal(capped.rows.find((r) => r.group === "signal" && r.year === "All")!.entries, 0);
  assert.match(cspCsv(res.rows).split("\n")[0], /^group,year,entries,assignment_rate,avg_loss_when_assigned,p5_outcome,worst5_avg_outcome,median_outcome$/);
});
