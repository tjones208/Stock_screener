import { test } from "node:test";
import assert from "node:assert/strict";
import type { StrategyDef } from "../src/engine/engine.ts";
import { runStudy, studyCsv, studyTable } from "../src/study.ts";
import { pullback } from "../src/strategies/pullback.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

test("study: forward returns from the next open to the Nth close, baseline on signal days, delisted names", async () => {
  const days = weekdays("2024-01-01", 12);
  // A: open 100 + i, close 101 + i. B: flat 50 open, close 55. GONE: stops trading after day 3.
  const rows = [
    ...days.map((d, i) => row("A", d, 100 + i, 101 + i)),
    ...days.map((d) => row("B", d, 50, 55)),
    ...days.slice(0, 4).map((d, i) => row("GONE", d, 20, 20 + i)),
  ];
  const seen: string[] = [];
  const def: StrategyDef = {
    name: "t", description: "", defaults: {}, warmupDays: 0,
    create: () => ({
      onClose(ctx) {
        seen.push(ctx.d);
        assert.equal(ctx.portfolio.tickers().length, 0);
        return ctx.i === 1 ? [{ side: "buy", ticker: "A", shares: 1 }, { side: "buy", ticker: "A", shares: 2 }] : [];
      },
      universe: (ctx) => [...ctx.today.keys()],
    }),
  };
  const { result: r, signals } = await runStudy(new MemorySource(rows), def, { strategy: "t", from: days[0], to: days[3], horizons: [1, 3, 5] });
  assert.deepEqual(r.horizons, [1, 3, 5]);
  // One signal (duplicates merged), entry at day 2's open 102; exits at the close of day 2, 4 and 6.
  assert.equal(signals.length, 1);
  assert.equal(signals[0].entry, 102);
  const [s1, s3, s5] = signals[0].r;
  assert.ok(Math.abs(s1! - (103 / 102 - 1)) < 1e-12 && Math.abs(s3! - (105 / 102 - 1)) < 1e-12 && Math.abs(s5! - (107 / 102 - 1)) < 1e-12);
  const all = r.rows.at(-1)!;
  assert.equal(all.year, "All");
  assert.deepEqual([all.signals, all.signalDays, all.baseline], [1, 1, 3]); // A, B, GONE on the one signal day
  // Baseline 5-day: A 107/102, B 55/50, GONE enters day 2 at 20 and its last close (day 3) is 23.
  const base5 = ((107 / 102 - 1) + (55 / 50 - 1) + (23 / 20 - 1)) / 3;
  assert.ok(Math.abs(all.base[2]! - base5) < 1e-12);
  assert.ok(Math.abs(all.edge[2]! - (s5! - base5)) < 1e-12);
  assert.equal(all.sigWin[0], 1);
  assert.ok(seen.includes(days[3]) && !seen.includes(days[4])); // the strategy only runs through `to`
  assert.match(studyTable(r), /All\s+1\s+\+0\.98%/);
  assert.match(studyCsv(r).split("\n")[0], /^year,signals,signal_days,baseline_stock_days,signal_1d_pct/);
});

test("study: pullback on a random market gives a per-year table with finite averages", async () => {
  const d = weekdays("2015-01-01", 400);
  let s = 3;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const rows = [];
  for (const t of ["SPY", ...Array.from({ length: 25 }, (_, k) => `T${k}`)]) {
    let c = 40 + rnd() * 40;
    const drift = t === "SPY" ? 0.0005 : (rnd() - 0.4) * 0.004;
    for (const day of d) {
      const o = c * (1 + (rnd() - 0.5) * 0.01), nc = o * (1 + drift + (rnd() - 0.5) * 0.04);
      rows.push({ ...row(t, day, o, nc), h: Math.max(o, nc) * 1.005, l: Math.min(o, nc) * 0.995, dv: nc * 1e6 });
      c = nc;
    }
  }
  const { result } = await runStudy(new MemorySource(rows), pullback as unknown as StrategyDef, { strategy: "pullback", params: { min_price: 1 }, from: d[0], to: d[380] });
  const all = result.rows.at(-1)!;
  assert.ok(all.signals > 0 && all.baseline > all.signals);
  assert.ok(result.rows.length >= 2);
  assert.ok(all.sig.every((x) => Number.isFinite(x)) && all.base.every((x) => Number.isFinite(x)));
});
