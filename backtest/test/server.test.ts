// The app's server: state, settings, presets, a batch job end to end, results API, path safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synth } from "../src/data/synth.ts";
import { prepare } from "../src/data/prepare.ts";
import { startServer } from "../src/server/server.ts";

test("app server: settings, presets, batch job, results", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bt-app-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  synth({ out: dir, years: 2, stocks: 20, seed: 5 });
  await prepare({ flat: join(dir, "flat"), ref: join(dir, "ref"), out: join(dir, "data"), log: () => {} });
  const app = await startServer({ port: 0, open: false, configDir: dir });
  t.after(() => app.server.close());
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(app.url + path, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body ? JSON.stringify(init.body) : undefined });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  assert.equal((await fetch(app.url + "/")).status, 200);
  await call("/api/settings", { method: "POST", body: { folders: { data: join(dir, "data"), results: join(dir, "results") } } });
  const st = (await call("/api/state")).json;
  assert.equal(st.data.ready, true);
  const names = st.strategies.map((s: { name: string }) => s.name);
  for (const n of ["buyhold", "sma-timing", "topn", "momentum", "low-vol-momentum"]) assert.ok(names.includes(n), n);
  const mom = st.strategies.find((s: { name: string }) => s.name === "momentum");
  assert.ok(mom.fields.some((f: { key: string; choices?: string[] }) => f.key === "rank_method" && f.choices?.includes("classic")));
  assert.ok(!mom.fields.some((f: { key: string }) => f.key === "min_market_cap")); // unusable in a backtest

  const preset = (await call("/api/presets", { method: "POST", body: { name: "Classic N=8", strategy: "momentum", params: { rank_method: "classic", n_max: 8 } } })).json;
  assert.equal((await call("/api/state")).json.presets[0].name, "Classic N=8");

  const job = (await call("/api/jobs", { method: "POST", body: { kind: "batch", spec: { name: "test", capital: 20000, bench: ["SPY"], runs: [
    { strategy: "momentum", params: preset.params, label: "classic" }, { strategy: "topn", params: { n: 5, minPrice: 1, minDollarVol: 0 }, label: "topn" },
  ] } } })).json;
  assert.ok(job.id);
  const done = await new Promise<Record<string, any>>((ok) => {
    const off = app.queue.subscribe(({ job: j }) => { if (j.id === job.id && (j.status === "done" || j.status === "failed")) { off(); ok(j); } });
  });
  assert.equal(done.status, "done", done.log?.slice(-5).join("\n"));
  assert.ok(done.progress && done.progress.total > 0);

  const list = (await call("/api/results")).json as unknown as { dir: string; runs: number; name: string }[];
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].runs, list[0].name], [2, "test"]);
  const b = (await call(`/api/results/batch?dir=${encodeURIComponent(list[0].dir)}`)).json;
  assert.equal(b.runs.length, 2);
  assert.ok(b.bench.SPY.length > 10 && Object.values(b.curves).every((c) => (c as unknown[]).length > 10));
  const run = (await call(`/api/results/run?dir=${encodeURIComponent(list[0].dir)}&run=${encodeURIComponent(b.runs[1].folder)}`)).json;
  assert.equal(run.summary.label, "topn");
  assert.ok(run.equity.length > 10 && Array.isArray(run.trades));

  // No escaping the results folder.
  assert.equal((await call(`/api/results/batch?dir=${encodeURIComponent("../..")}`)).status, 400);
  assert.equal((await call(`/api/results?dir=${encodeURIComponent("..")}`, { method: "DELETE" })).status, 400);
  // Bad key is refused; folder check reports what's there.
  assert.equal((await call("/api/key", { method: "POST", body: { key: "x" } })).status, 400);
  const info = (await call("/api/folder", { method: "POST", body: { path: join(dir, "flat") } })).json;
  assert.ok(info.csvFiles > 400);
});
