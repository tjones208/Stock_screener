// End to end on a synthetic market in Massive's flat-file layout: prepare → data source → strategies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synth } from "../src/data/synth.ts";
import { prepare } from "../src/data/prepare.ts";
import { ParquetSource } from "../src/data/store.ts";
import { runOne } from "../src/report.ts";
import type { Row } from "../src/engine/types.ts";

test("pipeline: split-adjusted features, delistings, and every strategy runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = synth({ out: dir, years: 3, stocks: 30, seed: 11 });
  await prepare({ flat: join(dir, "flat"), ref: join(dir, "ref"), out: join(dir, "data"), log: () => {} });
  const src = await ParquetSource.open(join(dir, "data"));
  t.after(() => src.close());
  const days = src.days();
  assert.equal(days.length, s.days);

  const all = await src.rows(days[0], days[days.length - 1]);
  const series = (tk: string) => days.map((d) => all.get(d)?.get(tk)).filter((r): r is Row => !!r);

  // The 2-for-1 split is adjusted away: no −50% day, and raw pre-split prices were halved.
  const sp = series(s.split.ticker);
  const worst = Math.min(...sp.map((r) => r.ret1 ?? 0));
  assert.ok(worst > -0.2, `worst daily return across the split: ${worst}`);

  // Features match a direct computation.
  const k = sp.length - 1;
  const sma20 = sp.slice(k - 19, k + 1).reduce((a, r) => a + r.c, 0) / 20;
  assert.ok(Math.abs(sp[k].sma20! - sma20) < 1e-6);
  assert.ok(Math.abs(sp[k].mom_12_1! - (sp[k - 21].c / sp[k - 252].c - 1)) < 1e-9);
  const hi = Math.max(...sp.slice(k - 251, k + 1).map((r) => r.c));
  assert.ok(Math.abs(sp[k].hi252! - hi) < 1e-9);
  assert.equal(sp[k].days_since_high, k - sp.map((r) => r.c).lastIndexOf(hi, k));
  assert.equal(sp[20].mom_12_1, null); // not enough history yet

  // The delisted ticker stops; the reference marks it inactive.
  assert.ok(series(s.delisted).length < days.length);
  assert.equal(src.tickers().get(s.delisted)?.active, false);
  assert.ok(src.dividends().size > 0);

  const opt = { from: days[260], to: days[days.length - 1], capital: 20_000, slippageBps: 10 };
  // Buy & hold SPY tracks SPY's own return (dividends reinvested, one slippage hit).
  const bh = await runOne(src, { strategy: "buyhold", params: { ticker: "SPY" }, opt });
  const spy = series("SPY");
  const i0 = spy.findIndex((r) => r.d === days[261]);
  const priceRet = spy.at(-1)!.c / spy[i0].o - 1;
  // Dividends reinvested: compound each ex-date payment as a yield on that day's close.
  let divGrowth = 1;
  for (const [d, list] of src.dividends()) {
    const dv = list.find((x) => x.ticker === "SPY");
    const r = all.get(d)?.get("SPY");
    if (dv && r && d > days[261]) divGrowth *= 1 + dv.cash / r.c;
  }
  const expected = (1 + priceRet) * divGrowth - 1;
  assert.ok(bh.result.dividends > 0);
  assert.ok(Math.abs(bh.stats.totalReturn - expected) < 0.01, `buyhold ${bh.stats.totalReturn} vs SPY total return ${expected}`);

  for (const strategy of ["sma-timing", "topn", "momentum"]) {
    const r = await runOne(src, { strategy, params: strategy === "topn" ? { n: 5, minPrice: 1, minDollarVol: 0 } : {}, opt, tax: { st: 0.3, lt: 0.15 } });
    // Equity identity on every day: cash + holdings at the close.
    for (const p of r.result.equity) assert.ok(Math.abs(p.equity - p.cash - p.invested) < 1e-6);
    assert.ok(r.result.equity.length === days.length - 260, strategy);
    assert.ok(r.stats.endValue > 0);
  }
  const topn = await runOne(src, { strategy: "topn", params: { n: 5, minPrice: 1, minDollarVol: 0 }, opt });
  assert.ok(topn.result.fills.length > 0, "topn trades");
});
