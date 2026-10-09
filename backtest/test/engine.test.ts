import { test } from "node:test";
import assert from "node:assert/strict";
import { Portfolio, ltDateOf } from "../src/engine/portfolio.ts";
import { runBacktest, type StrategyDef } from "../src/engine/engine.ts";
import { computeStats, yearlyTaxes } from "../src/engine/metrics.ts";
import { grid } from "../src/report.ts";
import { MemorySource, row, weekdays } from "./helpers.ts";

test("portfolio: lots, HIFO sells, ST/LT terms, dividends, wash sales both ways", () => {
  const p = new Portfolio(10_000);
  p.buy("A", 10, 100, "2024-01-02");
  p.buy("A", 10, 120, "2024-02-01");
  assert.equal(p.cash, 10_000 - 1000 - 1200);
  const c1 = p.sell("A", 10, 110, "2024-03-01"); // HIFO: the $120 lot
  assert.deepEqual([c1[0].entry, c1[0].pnl, c1[0].term], [120, -100, "ST"]);
  // The loss sale flags the $100 lot? No: bought 2024-01-02, more than 30 days before 2024-03-01.
  assert.equal(p.lotsOf("A")[0].wash, false);
  // Re-buy within 30 days of the loss sale → wash.
  assert.equal(p.buy("A", 1, 105, "2024-03-15").wash, true);
  assert.equal(ltDateOf("2024-01-02"), "2025-01-03");
  const lt = p.sell("A", 10, 150, "2025-01-03", "fifo");
  assert.equal(lt[0].term, "LT");
  // Dividends only on shares bought before the ex-date.
  p.buy("B", 100, 10, "2025-02-01");
  assert.equal(p.dividend("B", 0.5, "2025-02-01"), 0);
  assert.equal(p.dividend("B", 0.5, "2025-02-02"), 50);
});

test("taxes: ST and LT netted, losses carried forward, dividends ordinary", () => {
  const c = (exitD: string, pnl: number, term: "ST" | "LT") => ({ id: 0, ticker: "X", shares: 1, entry: 1, exit: 1, entryD: exitD, exitD, pnl, ret: 0, days: 1, term, wash: false });
  const t = yearlyTaxes([c("2024-05-01", 1000, "ST"), c("2024-06-01", -1500, "LT"), c("2025-03-01", 2000, "LT")], new Map([["2025", 100]]), { st: 0.3, lt: 0.15 });
  // 2024 nets to a −500 short-term loss, carried into 2025: it absorbs the $100 dividend, then the rest
  // offsets the long-term gain (2000 − 400 = 1600).
  assert.deepEqual(t.map((y) => [y.year, y.st, y.lt]), [["2024", 0, 0], ["2025", 0, 1600]]);
  assert.ok(Math.abs(t[1].tax - 1600 * 0.15) < 1e-9);
});

test("stats: CAGR, drawdown, exposure on a known curve", () => {
  const eq = [
    { d: "2020-01-01", equity: 100, cash: 0, invested: 100, positions: 1 },
    { d: "2020-07-01", equity: 120, cash: 0, invested: 120, positions: 1 },
    { d: "2020-10-01", equity: 90, cash: 90, invested: 0, positions: 0 },
    { d: "2021-01-01", equity: 121, cash: 0, invested: 121, positions: 1 },
  ];
  const s = computeStats(eq, []);
  assert.ok(Math.abs(s.cagr - (1.21 ** (1 / s.years) - 1)) < 1e-12);
  assert.equal(s.maxDrawdown, 90 / 120 - 1);
  assert.deepEqual([s.maxDrawdownStart, s.maxDrawdownEnd], ["2020-07-01", "2020-10-01"]);
  assert.equal(s.exposure, 0.75);
});

test("engine: orders work at the next open; limits, slippage, dividends, delisting", async () => {
  const days = weekdays("2024-01-01", 30);
  const rows = [
    ...days.map((d, i) => row("A", d, 100 + i, 100.5 + i)),
    ...days.slice(0, 10).map((d) => row("GONE", d, 50, 50)), // stops trading after day 10
  ];
  const src = new MemorySource(rows, [{ ticker: "A", ex_date: days[5], cash: 1 }]);
  const seen: string[] = [];
  const def: StrategyDef = {
    name: "t", description: "", defaults: {}, warmupDays: 0,
    create: () => ({
      onClose(ctx) {
        seen.push(ctx.d);
        // Never sees a future row.
        assert.ok([...ctx.today.values()].every((r) => r.d === ctx.d));
        if (ctx.i === 0) return [
          { side: "buy", ticker: "A", shares: 10 },
          { side: "buy", ticker: "A", shares: 5, limit: 95 },   // open 101 > 95 and low 101 > 95: unfilled
          { side: "buy", ticker: "GONE", shares: 10 },
        ];
        if (ctx.d === days[20]) return [{ side: "sell", ticker: "A", shares: "all", tag: "exit" }];
        return [];
      },
    }),
  };
  const r = await runBacktest(src, def, {}, { from: days[0], to: days[29], capital: 10_000, slippageBps: 100, delistAfter: 3 });
  assert.equal(seen.length, 30);
  const buyA = r.fills.find((f) => f.ticker === "A" && f.side === "buy")!;
  assert.equal(buyA.d, days[1]);
  assert.ok(Math.abs(buyA.price - 101 * 1.01) < 1e-9);     // next open + 1% slippage
  assert.equal(r.unfilled, 1);
  assert.equal(r.dividends, 10);                            // 10 shares × $1 on the ex-date
  const gone = r.fills.find((f) => f.ticker === "GONE" && f.side === "sell")!;
  assert.equal(gone.tag, "delisted");
  assert.equal(gone.d, days[12]);                           // 3 trading days without a bar
  const sellA = r.fills.find((f) => f.ticker === "A" && f.side === "sell")!;
  assert.equal(sellA.d, days[21]);
  assert.ok(Math.abs(sellA.price - 121 * 0.99) < 1e-9);
  // Equity identity at the end: all cash.
  const last = r.equity.at(-1)!;
  assert.equal(last.invested, 0);
  assert.ok(Math.abs(last.equity - last.cash) < 1e-9);
});

test("engine: a buy limit under the open fills at the limit when the low reaches it", async () => {
  const days = weekdays("2024-01-01", 3);
  const src = new MemorySource([row("A", days[0], 100, 100), { ...row("A", days[1], 105, 103), l: 99 }, row("A", days[2], 103, 103)]);
  const def: StrategyDef = { name: "t", description: "", defaults: {}, warmupDays: 0,
    create: () => ({ onClose: (ctx) => (ctx.i === 0 ? [{ side: "buy", ticker: "A", shares: (p: number) => Math.floor(1000 / p), limit: 100 }] : []) }) };
  const r = await runBacktest(src, def, {}, { from: days[0], to: days[2], capital: 10_000, slippageBps: 50 });
  assert.deepEqual([r.fills[0].price, r.fills[0].shares], [100, 10]);
});

test("sweep grid: cartesian product", () => {
  assert.deepEqual(grid({ a: [1, 2], b: ["x", "y"] }), [{ a: 1, b: "x" }, { a: 1, b: "y" }, { a: 2, b: "x" }, { a: 2, b: "y" }]);
});

test("batch: a run that requires sectors is skipped when the data has no SIC codes", async () => {
  const { runBatch } = await import("../src/batch.ts");
  const { mkdtempSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const days = weekdays("2024-01-01", 30);
  const src = new MemorySource(days.flatMap((d, i) => [row("SPY", d, 100 + i, 100 + i), row("A", d, 50, 50)]));
  const logs: string[] = [];
  const out = mkdtempSync(join(tmpdir(), "bt-req-"));
  const r = await runBatch(src, { name: "req", from: days[0], to: days[29], bench: [], runs: [
    { strategy: "buyhold", label: "plain" }, { strategy: "buyhold", label: "needs sectors", requires: "sectors" }] }, out, (e) => { if (e.type === "log") logs.push(e.text); });
  assert.deepEqual(r.rows.map((x) => x.label), ["plain"]);
  assert.ok(logs.some((l) => /Skipped "needs sectors".*no sector/.test(l)));
  assert.ok(existsSync(join(r.dir, "batch-req.csv")) && readFileSync(join(r.dir, "batch-req.csv"), "utf8").includes("plain"));
});
