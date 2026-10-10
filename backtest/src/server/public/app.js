// Backtester UI: Data (setup wizard), Strategies (library, parameters, presets, run), Jobs, Results, Studies.
const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x, k = 1) => (x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(k)}%`);
const num = (x, k = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toLocaleString(undefined, { minimumFractionDigits: k, maximumFractionDigits: k }));
const money = (x) => (x == null || !Number.isFinite(x) ? "—" : `$${Math.round(x).toLocaleString()}`);
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

const OFFLINE = "Can't reach the Backtester. Is the black \"Start Backtester\" window still open? If it closed or shows an error, " +
  "copy what it says (it's also saved in backtest\\backtester.log), then double-click Start Backtester.bat again and reload this page.";
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch {
    showOffline(true);
    throw new Error(OFFLINE);
  }
  showOffline(false);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}
function showOffline(on) {
  let b = document.getElementById("offline");
  if (!b) { b = document.createElement("div"); b.id = "offline"; b.className = "card err"; b.style.margin = "12px 20px"; document.body.insertBefore(b, document.querySelector("main")); }
  b.textContent = OFFLINE;
  b.hidden = !on;
}
function toast(msg, ms = 3500) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

const S = { state: null, tab: "data", jobs: new Map(), sel: null, edits: {}, checked: new Set(), results: null, view: null, studies: null, study: null, studyForm: null };

// ───────── tabs ─────────
function setTab(t) {
  S.tab = t;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === t);
  for (const s of document.querySelectorAll(".tab")) s.classList.toggle("active", s.id === `tab-${t}`);
  location.hash = t;
  render();
}
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

async function refresh() {
  S.state = await api("/api/state");
  for (const j of S.state.jobs) S.jobs.set(j.id, j);
  const d = S.state.data;
  $("#dataPill").textContent = d.ready ? `Data ${d.from} → ${d.to} · ${d.tickers.toLocaleString()} tickers` : "No prepared data";
  $("#dataPill").className = `pill ${d.ready ? "ok" : "muted"}`;
  render();
}
function render() {
  if (!S.state) return;
  ({ data: renderData, strategies: renderStrategies, jobs: renderJobs, results: renderResults, studies: renderStudies })[S.tab]();
  const running = [...S.jobs.values()].filter((j) => j.status === "running" || j.status === "queued").length;
  $("#jobBadge").hidden = !running; $("#jobBadge").textContent = running;
}

// ───────── live jobs ─────────
function connectEvents() {
  const es = new EventSource("/api/events");
  es.onerror = () => { if (es.readyState !== EventSource.OPEN) api("/api/state").then(() => showOffline(false)).catch(() => {}); };
  es.onopen = () => showOffline(false);
  es.onmessage = (m) => {
    const { job, line } = JSON.parse(m.data);
    const prev = S.jobs.get(job.id);
    job.log = prev?.log ?? [];
    if (line) { job.log.push(line); if (job.log.length > 400) job.log.splice(0, job.log.length - 400); }
    S.jobs.set(job.id, job);
    if (prev && prev.status !== job.status && (job.status === "done" || job.status === "failed")) {
      toast(`${job.title}: ${job.status === "done" ? "finished" : "failed"}`);
      refresh();
      if (job.kind === "batch" && job.status === "done") S.results = null;
      if (job.kind === "study" && job.status === "done") { S.studies = null; S.study = null; }
    }
    if (S.tab === "jobs") updateJobCard(job); else render();
  };
}

// ───────── Data ─────────
const FOLDERS = [
  ["dayCsv", "Daily bars (Massive day_aggs_v1 download)", "e.g. D:\\massive\\day_aggs_v1"],
  ["dayParquet", "Daily bars as Parquet (output of step 1)", "e.g. D:\\massive\\parquet\\day_aggs"],
  ["minuteCsv", "Minute bars download (optional)", "e.g. D:\\massive\\minute_aggs_v1"],
  ["minuteParquet", "Minute bars as Parquet (optional)", "e.g. D:\\massive\\parquet\\minute_aggs"],
  ["ref", "Reference data (step 2 writes here)", "e.g. D:\\massive\\ref"],
  ["data", "Prepared backtest data (step 3 writes here)", "e.g. D:\\massive\\bt"],
  ["results", "Results", "where each backtest's files go"],
];
function lastJob(kind) { return [...S.jobs.values()].find((j) => j.kind === kind); }
function jobLine(kind) {
  const j = lastJob(kind);
  if (!j) return "";
  const cls = j.status === "done" ? "ok" : j.status === "failed" ? "fail" : "run";
  return `<span class="pill ${cls}">${j.status}</span> <span class="small muted">${esc(j.error || j.progress?.label || "")}</span>`;
}
function renderData() {
  const s = S.state, f = s.settings.folders, d = s.data;
  const root = $("#tab-data");
  root.innerHTML = `
    <div class="card">
      <div class="row spread"><h2>Your data</h2><button class="btn" id="demo">Try demo data</button></div>
      ${d.ready ? `<div class="tiles">
        <div class="tile"><div class="k">Prepared period</div><div class="v">${d.from.slice(0, 4)}–${d.to.slice(0, 4)}</div><div class="s">${d.from} → ${d.to}</div></div>
        <div class="tile"><div class="k">Trading days</div><div class="v">${d.days.toLocaleString()}</div></div>
        <div class="tile"><div class="k">Tickers</div><div class="v">${d.tickers.toLocaleString()}</div><div class="s">${d.common.toLocaleString()} common stocks · ${d.delisted.toLocaleString()} delisted</div></div>
        <div class="tile"><div class="k">Folder</div><div class="v small" style="font-size:13px;word-break:break-all">${esc(f.data)}</div></div>
      </div>` : `<p class="muted">No prepared data yet. Set the folders below and run steps 1–3, or click <b>Try demo data</b> to explore the app with a synthetic market (takes about a minute).</p>`}
    </div>
    <div class="card">
      <h3>Folders</h3>
      <p class="small muted">Paste full folder paths (in File Explorer: click the address bar, copy). Folders are checked as you type; nothing is moved or deleted.</p>
      <div class="folders">${FOLDERS.map(([k, label, ph]) => `
        <div>${label}</div><input data-folder="${k}" value="${esc(f[k])}" placeholder="${esc(ph)}" />
        <button class="btn small" data-openfolder="${k}" title="Open in File Explorer">Open</button>
        <div class="info" id="info-${k}"></div>`).join("")}
      </div>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="saveFolders">Save folders</button></div>
    </div>
    <div class="card">
      <h3>Massive API key</h3>
      <div class="row">
        <span class="pill ${s.keySet ? "ok" : ""}">${s.keySet ? "Saved on this computer" : "Not set"}</span>
        <input id="key" type="password" placeholder="Paste your Massive API key" style="width:320px" autocomplete="off" />
        <button class="btn" id="saveKey">Save key</button>
      </div>
      <p class="small muted">Stored only in <code>backtest\\.env</code> on this computer (never uploaded or committed). Needed for step 2 only.</p>
    </div>
    <div class="card">
      <h3>Steps</h3>
      <div class="steps">
        <div class="step"><div><span class="n">1</span><b>Convert to Parquet</b></div>
          <div class="small muted">Turns the downloaded *.csv.gz files into compact Parquet. Re-run after each download: only new days are converted.</div>
          <div class="row"><button class="btn" data-job="convert-day">Convert daily bars</button><button class="btn" data-job="convert-minute">Convert minute bars</button></div>
          <div>${jobLine("convert")}</div></div>
        <div class="step"><div><span class="n">2</span><b>Download reference data</b></div>
          <div class="small muted">Splits, dividends, and every ticker including delisted ones. SIC codes (for sector caps) take one request per stock.</div>
          <label class="row small"><input type="checkbox" id="details" checked /> Include SIC codes (slower)</label>
          <div class="row"><button class="btn" data-job="fetch-ref" ${s.keySet ? "" : "disabled"}>Download</button></div>
          <div>${jobLine("fetch-ref")}</div></div>
        <div class="step"><div><span class="n">3</span><b>Prepare backtest data</b></div>
          <div class="small muted">Split-adjusts prices and computes the features strategies use. Uses the Parquet folder if it has files, otherwise the CSVs.</div>
          <div class="row"><label class="field">Start year (optional)<input id="prepFrom" value="${esc(s.settings.prepare.from)}" placeholder="2005-01-01" style="width:130px"/></label>
          <label class="field">Memory<input id="prepMem" value="${esc(s.settings.prepare.memory)}" style="width:80px"/></label></div>
          <div class="row"><button class="btn primary" data-job="prepare">Prepare</button></div>
          <div>${jobLine("prepare")}</div></div>
        <div class="step"><div><span class="n">4</span><b>Earnings dates (SEC EDGAR)</b> <span class="small muted">optional</span></div>
          <div class="small muted">For the earnings drift study: every 8-K with item 2.02 for each company (delisted ones included, via the CIKs in step 2's reference data).
            SEC requires a contact email with each request and at most 10 requests a second; this uses 8. About an hour the first time; it resumes if stopped.</div>
          <label class="field">Your contact email (sent to SEC only)<input id="secEmail" value="${esc(s.settings.sec?.email || "")}" placeholder="you@example.com" style="width:240px"/></label>
          <div class="row"><button class="btn" data-job="fetch-earnings">Download earnings dates</button></div>
          <div>${jobLine("fetch-earnings")}</div></div>
      </div>
    </div>`;
  for (const [k] of FOLDERS) checkFolder(k, f[k]);
  root.querySelectorAll("[data-folder]").forEach((i) => i.addEventListener("input", () => { clearTimeout(i._t); i._t = setTimeout(() => checkFolder(i.dataset.folder, i.value), 400); }));
  root.querySelectorAll("[data-openfolder]").forEach((b) => b.addEventListener("click", () => api("/api/open", { method: "POST", body: { path: $(`[data-folder=${b.dataset.openfolder}]`).value } })));
  $("#saveFolders").onclick = async () => {
    // Pasted paths often come with quotes ("Copy as path"); strip them.
    const folders = Object.fromEntries([...root.querySelectorAll("[data-folder]")].map((i) => [i.dataset.folder, i.value.trim().replace(/^["']+|["']+$/g, "").trim()]));
    await api("/api/settings", { method: "POST", body: { folders } }); toast("Folders saved"); refresh();
  };
  $("#saveKey").onclick = async () => {
    try { await api("/api/key", { method: "POST", body: { key: $("#key").value } }); toast("API key saved on this computer"); refresh(); } catch (e) { toast(e.message); }
  };
  $("#demo").onclick = () => startJob({ kind: "demo" });
  root.querySelectorAll("[data-job]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.job === "prepare") await api("/api/settings", { method: "POST", body: { prepare: { from: $("#prepFrom").value.trim(), memory: $("#prepMem").value.trim() || "8GB" } } });
    if (b.dataset.job === "fetch-earnings") await api("/api/settings", { method: "POST", body: { sec: { email: $("#secEmail").value.trim() } } });
    startJob({ kind: b.dataset.job, details: $("#details")?.checked });
  }));
}
async function checkFolder(k, path) {
  const box = $(`#info-${k}`); if (!box) return;
  if (!path) { box.textContent = ""; return; }
  const i = await api("/api/folder", { method: "POST", body: { path } }).catch(() => null);
  if (!i) return;
  if (!i.exists) { box.innerHTML = `<span class="warn">Doesn't exist yet${["dayParquet", "minuteParquet", "ref", "data", "results"].includes(k) ? " (it will be created)" : ""}</span>`; return; }
  const bits = [];
  if (i.csvFiles) bits.push(`${i.csvFiles.toLocaleString()} daily files, ${i.firstDay} → ${i.lastDay} (${i.gb} GB)`);
  if (i.parquetFiles) bits.push(`${i.parquetFiles.toLocaleString()} Parquet files`);
  if (i.refFiles?.length) bits.push(`reference: ${i.refFiles.join(", ")}`);
  if (i.prepared) bits.push("prepared data set");
  if (i.backtests) bits.push(`${i.backtests} backtest${i.backtests === 1 ? "" : "s"}`);
  box.innerHTML = `<span class="good">✓</span> ${esc(bits.join(" · ") || "empty folder")}`;
}
async function startJob(body) {
  try { const j = await api("/api/jobs", { method: "POST", body }); S.jobs.set(j.id, j); toast(`Started: ${j.title}`); setTab("jobs"); } catch (e) { toast(e.message, 6000); }
}

// ───────── Strategies ─────────
function libItems() {
  const s = S.state;
  return [
    ...s.strategies.map((x) => ({ id: `s:${x.name}`, kind: "strategy", strategy: x.name, name: x.name, desc: x.description, source: x.source, params: {}, sweep: {} })),
    ...s.presets.map((p) => ({ id: `p:${p.id}`, kind: "preset", presetId: p.id, strategy: p.strategy, name: p.name, desc: `Preset of ${p.strategy}`, source: "preset", params: p.params || {}, sweep: p.sweep || {} })),
  ];
}
function stratDef(name) { return S.state.strategies.find((x) => x.name === name); }
function edit(item) {
  if (!S.edits[item.id]) S.edits[item.id] = { params: { ...item.params }, sweep: { ...item.sweep } };
  return S.edits[item.id];
}
// "null" / "none" (or blank, for a setting that is off by default) switch an optional number off.
function coerce(v, like) {
  if (typeof like === "boolean") return v === true || v === "true" || v === "on";
  const s = String(v ?? "").trim();
  if (s === "null" || s === "none") return null;
  if (typeof like === "number") { const n = Number(s); return s !== "" && Number.isFinite(n) ? n : like; }
  if (like === null) { const n = Number(s); return s === "" ? null : Number.isFinite(n) ? n : s; }
  return v;
}
function sweepValues(raw, like) {
  return String(raw || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => coerce(x, like));
}
function runsFor(item) {
  const def = stratDef(item.strategy); if (!def) return [];
  const e = edit(item);
  const grid = Object.entries(e.sweep).map(([k, raw]) => [k, sweepValues(raw, def.defaults[k])]).filter(([, v]) => v.length);
  let combos = [{}];
  for (const [k, vals] of grid) combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  return combos.map((c) => {
    const params = { ...e.params, ...c };
    const vary = Object.entries(c).map(([k, v]) => `${k}=${v}`).join(" ");
    return { strategy: item.strategy, params, label: `${item.name}${vary ? ` ${vary}` : ""}` };
  });
}
function renderStrategies() {
  const s = S.state, items = libItems();
  if (!S.sel || !items.find((i) => i.id === S.sel)) S.sel = items.find((i) => i.strategy === "momentum")?.id ?? items[0]?.id;
  const sel = items.find((i) => i.id === S.sel);
  const allRuns = items.filter((i) => S.checked.has(i.id)).flatMap(runsFor);
  const r = s.settings.run;
  const root = $("#tab-strategies");
  root.innerHTML = `
    <div class="grid2">
      <div class="card">
        <div class="row spread"><h3>Strategy library</h3><button class="btn small" id="reload" title="Reload after adding or editing files in the strategies folder">Reload</button></div>
        <p class="small muted">Tick the strategies to run. Add your own as .ts files in<br><code style="word-break:break-all">${esc(s.strategyFolder)}</code></p>
        ${s.strategyErrors.map((e) => `<div class="err">⚠ ${esc(e.file)}: ${esc(e.error)}</div>`).join("")}
        <div class="lib">
          <div class="group">Strategies</div>
          ${items.filter((i) => i.kind === "strategy").map(libRow).join("")}
          <div class="group">Saved presets</div>
          ${items.filter((i) => i.kind === "preset").map(libRow).join("") || '<div class="small muted" style="padding:4px 8px">Save a strategy\'s settings as a preset to reuse them.</div>'}
        </div>
      </div>
      <div>
        <div class="card" id="editor">${sel ? editorHtml(sel) : ""}</div>
        <div class="card">
          <h3>Run</h3>
          <div class="row">
            <label class="field">From<input id="rFrom" value="${esc(r.from)}" placeholder="first possible" style="width:130px"/></label>
            <label class="field">To<input id="rTo" value="${esc(r.to)}" placeholder="latest" style="width:130px"/></label>
            <label class="field">Starting capital ($)<input id="rCap" value="${r.capital}" style="width:110px"/></label>
            <label class="field">Slippage (bps per side)<input id="rSlip" value="${r.slippageBps}" style="width:90px"/></label>
            <label class="field">Commission ($/order)<input id="rCom" value="${r.commission}" style="width:90px"/></label>
            <label class="field">Tax ST / LT<input id="rTax" value="${r.taxSt},${r.taxLt}" style="width:90px"/></label>
            <label class="field">Benchmarks<input id="rBench" value="${esc(r.bench)}" style="width:120px"/></label>
            <label class="field">Batch name<input id="rName" placeholder="optional" style="width:160px"/></label>
          </div>
          <div class="row spread" style="margin-top:12px">
            <div>${allRuns.length ? `<b>${allRuns.length} run${allRuns.length === 1 ? "" : "s"}</b> <span class="muted small">${esc(summarizeRuns(allRuns))}</span>` : '<span class="muted">Tick at least one strategy in the library.</span>'}</div>
            <button class="btn primary" id="start" ${allRuns.length && s.data.ready ? "" : "disabled"}>Start backtest</button>
          </div>
          ${s.data.ready ? "" : '<p class="small warn">Prepare data first (Data tab), or try the demo data.</p>'}
          ${allRuns.length > 200 ? '<p class="small warn">That is a lot of runs; each one takes from seconds to minutes depending on the period.</p>' : ""}
        </div>
        <div class="card">
          <h3>Saved batches</h3>
          <p class="small muted">Batch files in <code style="word-break:break-all">${esc(s.batchFolder || "")}</code> keep their own period, capital, slippage and benchmarks.</p>
          ${(s.batches || []).length ? `<div class="tablewrap"><table><thead><tr><th class="l">Batch</th><th>Period</th><th>Capital</th><th>Slippage</th><th class="l">Runs</th><th></th></tr></thead><tbody>
            ${s.batches.map((b) => b.error ? `<tr><td class="l">${esc(b.file)}</td><td colspan="5" class="l bad">${esc(b.error)}</td></tr>`
              : `<tr><td class="l"><b>${esc(b.name)}</b><div class="small muted">${esc(b.file)}</div></td><td>${esc(b.from || "start")} → ${esc(b.to || "end")}</td>
                <td>${money(b.capital)}</td><td>${b.slippageBps ?? "—"} bps</td><td class="l small">${b.runs.map(esc).join("<br>")}</td>
                <td><button class="btn primary small" data-sbatch="${esc(b.file)}" ${s.data.ready ? "" : "disabled"}>Run</button></td></tr>`).join("")}
          </tbody></table></div>` : '<div class="small muted">No batch files yet.</div>'}
        </div>
      </div>
    </div>`;
  root.querySelectorAll(".lib .item").forEach((el) => el.addEventListener("click", (ev) => {
    if (ev.target.matches("input[type=checkbox]")) { ev.target.checked ? S.checked.add(el.dataset.id) : S.checked.delete(el.dataset.id); renderStrategies(); return; }
    S.sel = el.dataset.id; renderStrategies();
  }));
  $("#reload").onclick = async () => { const r2 = await api("/api/strategies/reload", { method: "POST" }); toast(`${r2.count} strategies loaded${r2.errors.length ? `, ${r2.errors.length} with errors` : ""}`); refresh(); };
  if (sel) bindEditor(sel);
  root.querySelectorAll("[data-sbatch]").forEach((b) => (b.onclick = () => startJob({ kind: "saved-batch", file: b.dataset.sbatch })));
  $("#start").onclick = async () => {
    const [st, lt] = $("#rTax").value.split(",").map(Number);
    const run = { from: $("#rFrom").value.trim(), to: $("#rTo").value.trim(), capital: Number($("#rCap").value), slippageBps: Number($("#rSlip").value), commission: Number($("#rCom").value), taxSt: st, taxLt: lt, bench: $("#rBench").value.trim() };
    await api("/api/settings", { method: "POST", body: { run } });
    const spec = { name: $("#rName").value.trim() || undefined, from: run.from || undefined, to: run.to || undefined, capital: run.capital, slippageBps: run.slippageBps, commission: run.commission,
      tax: { st: run.taxSt, lt: run.taxLt }, bench: run.bench.split(",").map((x) => x.trim()).filter(Boolean), runs: allRuns };
    startJob({ kind: "batch", spec });
  };
}
function summarizeRuns(runs) {
  const by = {};
  for (const r of runs) by[r.strategy] = (by[r.strategy] || 0) + 1;
  return Object.entries(by).map(([k, n]) => `${k} ×${n}`).join(", ");
}
function libRow(i) {
  const n = runsFor(i).length;
  return `<div class="item ${i.id === S.sel ? "sel" : ""}" data-id="${esc(i.id)}">
    <input type="checkbox" ${S.checked.has(i.id) ? "checked" : ""} title="Include in the next run" />
    <div><div class="name">${esc(i.name)} ${n > 1 ? `<span class="pill">${n} runs</span>` : ""}</div><div class="desc">${esc(i.desc)}</div>
    <div class="small muted">${esc(i.source)}</div></div></div>`;
}
// A strategy with field metadata shows just those fields (the rest keep their defaults).
function fieldsOf(def) {
  return def.fields ?? Object.keys(def.defaults).map((k) => ({ key: k, label: k, group: "Parameters" }));
}
function editorHtml(item) {
  const def = stratDef(item.strategy);
  if (!def) return `<div class="err">Strategy ${esc(item.strategy)} isn't loaded.</div>`;
  const e = edit(item);
  const groups = {};
  for (const f of fieldsOf(def)) (groups[f.group || "Parameters"] ||= []).push(f);
  const input = (f) => {
    const dflt = def.defaults[f.key], v = f.key in e.params ? e.params[f.key] : dflt, changed = e.params[f.key] !== undefined && e.params[f.key] !== dflt;
    const ctl = typeof dflt === "boolean" ? `<input type="checkbox" data-p="${f.key}" ${v ? "checked" : ""}/>`
      : f.choices ? `<select data-p="${f.key}">${f.choices.map((c) => `<option ${c === v ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`
      : `<input data-p="${f.key}" value="${v == null ? "" : esc(v)}" ${v == null ? 'placeholder="none"' : ""} title="${esc(f.help || "")}" />`;
    const showSweep = S.showSweep || e.sweep[f.key];
    return `<div class="param ${changed ? "changed" : ""}"><span class="lbl" title="${esc(f.key)}">${esc(f.label)}</span>${ctl}
      ${showSweep ? `<input class="sweep" data-s="${f.key}" value="${esc(e.sweep[f.key] || "")}" placeholder="values to test, e.g. ${typeof (e.params[f.key] ?? def.defaults[f.key]) === "number" ? "8,13,20" : "a,b"}" />` : ""}</div>`;
  };
  return `<div class="row spread"><div><h3>${esc(item.name)}</h3><div class="small muted">${esc(item.desc)}${item.kind === "preset" ? ` · strategy: ${esc(item.strategy)}` : ""}</div></div>
    <div class="row"><button class="btn" id="reset">Reset to defaults</button><button class="btn" id="savePreset">Save as preset</button>
    ${item.kind === "preset" ? '<button class="btn" id="updPreset">Update preset</button><button class="btn danger" id="delPreset">Delete preset</button>' : ""}</div></div>
    <div class="row spread"><p class="small muted" style="margin:6px 0">Changed values are highlighted. Sweep: list several values for a setting (e.g. <code>8,13,20</code>); every combination becomes a run.</p>
      <label class="row small"><input type="checkbox" id="showSweep" ${S.showSweep ? "checked" : ""}/> Show sweep boxes</label></div>
    ${Object.entries(groups).map(([g, fs]) => `<fieldset><legend>${esc(g)}</legend><div class="params">${fs.map(input).join("")}</div></fieldset>`).join("")}`;
}
function bindEditor(item) {
  const def = stratDef(item.strategy); if (!def) return;
  const e = edit(item);
  const root = $("#editor");
  root.querySelectorAll("[data-p]").forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.p, v = el.type === "checkbox" ? el.checked : coerce(el.value, def.defaults[k]);
    if (v === def.defaults[k] && item.kind === "strategy") delete e.params[k]; else e.params[k] = v;
    el.closest(".param").classList.toggle("changed", v !== def.defaults[k]);
    S.checked.add(item.id);
    updateRunCount();
  }));
  root.querySelectorAll("[data-s]").forEach((el) => el.addEventListener("input", () => {
    if (el.value.trim()) e.sweep[el.dataset.s] = el.value; else delete e.sweep[el.dataset.s];
    S.checked.add(item.id);
    clearTimeout(el._t); el._t = setTimeout(() => renderStrategies(), 600);
  }));
  $("#showSweep").onchange = (ev) => { S.showSweep = ev.target.checked; renderStrategies(); };
  $("#reset").onclick = () => { S.edits[item.id] = { params: item.kind === "preset" ? { ...item.params } : {}, sweep: {} }; renderStrategies(); };
  $("#savePreset").onclick = async () => {
    const name = prompt("Preset name", `${item.strategy} ${new Date().toISOString().slice(0, 10)}`);
    if (!name) return;
    const p = await api("/api/presets", { method: "POST", body: { name, strategy: item.strategy, params: e.params, sweep: e.sweep } });
    toast("Preset saved"); await refresh(); S.sel = `p:${p.id}`; S.checked.add(`p:${p.id}`); renderStrategies();
  };
  const upd = $("#updPreset");
  if (upd) upd.onclick = async () => { await api("/api/presets", { method: "POST", body: { id: item.presetId, name: item.name, strategy: item.strategy, params: e.params, sweep: e.sweep } }); toast("Preset updated"); delete S.edits[item.id]; refresh(); };
  const del = $("#delPreset");
  if (del) del.onclick = async () => { if (!confirm(`Delete preset "${item.name}"?`)) return; await api(`/api/presets/${encodeURIComponent(item.presetId)}`, { method: "DELETE" }); S.checked.delete(item.id); S.sel = null; refresh(); };
}
function updateRunCount() { clearTimeout(updateRunCount._t); updateRunCount._t = setTimeout(renderStrategies, 300); }

// ───────── Jobs ─────────
function jobHtml(j) {
  const p = j.progress, frac = p && p.total ? p.done / p.total : j.status === "done" ? 1 : 0;
  const run = p?.runs ? ` · run ${p.run} of ${p.runs}` : "";
  const cls = j.status === "done" ? "ok" : j.status === "failed" ? "fail" : j.status === "running" ? "run" : "";
  return `<div class="card" id="job-${j.id}">
    <div class="row spread"><div><b>${esc(j.title)}</b> <span class="pill ${cls}">${j.status}</span> <span class="small muted">${esc(p?.label || "")}${run}</span></div>
      <div class="row">${j.status === "done" && j.kind === "batch" && j.result?.dir ? `<button class="btn primary" data-view="${esc(j.result.dir)}">View results</button>` : ""}
      ${j.status === "running" || j.status === "queued" ? `<button class="btn" data-cancel="${j.id}">Cancel</button>` : ""}</div></div>
    <div class="progress" style="margin-top:8px"><div style="width:${(frac * 100).toFixed(1)}%"></div></div>
    ${j.error ? `<div class="err" style="margin-top:6px">${esc(j.error)}</div>` : ""}
    <details ${j.status === "running" || j.status === "failed" ? "open" : ""}><summary class="small muted">Log</summary><pre class="log">${esc((j.log || []).slice(-200).join("\n"))}</pre></details>
  </div>`;
}
function renderJobs() {
  const jobs = [...S.jobs.values()].sort((a, b) => b.id - a.id);
  const root = $("#tab-jobs");
  root.innerHTML = jobs.length ? jobs.map(jobHtml).join("") : '<div class="card empty">No jobs yet. Start one from the Data or Strategies tab.</div>';
  bindJobs(root);
}
function bindJobs(root) {
  root.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: "POST" })));
  root.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { const name = b.dataset.view.split(/[\\/]/).pop(); S.view = { batch: name }; S.results = null; setTab("results"); }));
}
function updateJobCard(j) {
  const old = $(`#job-${j.id}`);
  if (!old) { renderJobs(); return; }
  const pre = old.querySelector("pre"), stick = pre && pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  const open = old.querySelector("details")?.open;
  const fresh = h(jobHtml(j));
  if (open !== undefined) fresh.querySelector("details").open = open;
  old.replaceWith(fresh);
  bindJobs(fresh);
  const p2 = fresh.querySelector("pre"); if (p2 && stick) p2.scrollTop = p2.scrollHeight;
  const running = [...S.jobs.values()].filter((x) => x.status === "running" || x.status === "queued").length;
  $("#jobBadge").hidden = !running; $("#jobBadge").textContent = running;
}

// ───────── Results ─────────
const STAT_COLS = [
  ["cagr", "CAGR", pct], ["afterTaxCagr", "After-tax CAGR", pct], ["maxDrawdown", "Max drawdown", pct], ["sharpe", "Sharpe", (x) => num(x)],
  ["sortino", "Sortino", (x) => num(x)], ["volatility", "Volatility", pct], ["calmar", "Calmar", (x) => num(x)], ["trades", "Trades", (x) => num(x, 0)],
  ["winRate", "Win rate", (x) => pct(x, 0)], ["turnover", "Turnover", (x) => `${num(x, 1)}×`], ["exposure", "Invested", (x) => pct(x, 0)], ["endValue", "End value", money],
];
async function renderResults() {
  const root = $("#tab-results");
  if (S.view?.run) return renderRun(root);
  if (S.view?.batch) return renderBatch(root);
  if (!S.results) { root.innerHTML = '<div class="card empty">Loading…</div>'; S.results = await api("/api/results").catch(() => []); }
  const list = S.results;
  root.innerHTML = `<div class="card"><div class="row spread"><h2>Results</h2><div class="row"><button class="btn" id="rRefresh">Refresh</button><button class="btn" id="rOpen">Open results folder</button></div></div>
    ${list.length ? `<div class="tablewrap"><table><thead><tr><th class="l">Run</th><th class="l">Strategies</th><th>Period</th><th>Runs</th><th class="l">Best (by Sharpe)</th><th>Best CAGR</th><th>Best Sharpe</th><th>SPY CAGR</th><th></th></tr></thead><tbody>
      ${list.map((b) => `<tr><td class="l"><a data-batch="${esc(b.dir)}">${esc(b.name || b.dir.slice(20) || b.dir)}</a><div class="small muted">${esc(b.created.slice(0, 16).replace("T", " "))}</div></td>
        <td class="l">${esc(b.strategies.join(", "))}</td><td>${esc(b.from)} → ${esc(b.to)}</td><td>${b.runs}</td>
        <td class="l">${esc(b.best?.label || "")}</td><td>${pct(b.best?.cagr)}</td><td>${num(b.best?.sharpe)}</td><td>${pct(b.spyCagr)}</td>
        <td><button class="btn danger small" data-del="${esc(b.dir)}">Delete</button></td></tr>`).join("")}
      </tbody></table></div>` : '<div class="empty">No backtests yet. Run one from the Strategies tab.</div>'}</div>`;
  root.querySelectorAll("[data-batch]").forEach((a) => (a.onclick = () => { S.view = { batch: a.dataset.batch }; renderResults(); }));
  root.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { if (!confirm("Delete this result folder from disk?")) return; await api(`/api/results?dir=${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" }); S.results = null; renderResults(); }));
  $("#rRefresh").onclick = () => { S.results = null; renderResults(); };
  $("#rOpen").onclick = () => api("/api/open", { method: "POST", body: { path: S.state.settings.folders.results } });
}
function sortable(table, rows, cols, onSort) {
  table.querySelectorAll("th[data-k]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.k, dir = table._sort?.k === k && table._sort.dir === -1 ? 1 : -1;
    table._sort = { k, dir }; onSort(k, dir);
  }));
}
async function renderBatch(root) {
  const b = S.view.data && S.view.data.dir === S.view.batch ? S.view.data : await api(`/api/results/batch?dir=${encodeURIComponent(S.view.batch)}`);
  S.view.data = b;
  const runs = b.runs || [];
  const sortK = S.view.sort?.k || "sharpe", sortDir = S.view.sort?.dir ?? -1;
  const sorted = [...runs].sort((x, y) => sortDir * ((x.stats[sortK] ?? -Infinity) - (y.stats[sortK] ?? -Infinity)) || 0);
  if (!S.view.pick) S.view.pick = new Set(sorted.slice(0, Math.min(5, sorted.length)).map((r) => r.folder));
  const spec = b.spec || {};
  root.innerHTML = `<div class="crumbs"><a id="back">Results</a> › <b>${esc(b.name || S.view.batch)}</b></div>
    <div class="card"><div class="row spread"><div><h2>${esc(b.name || `${runs.length} run${runs.length === 1 ? "" : "s"}`)}</h2>
      <div class="small muted">${esc(spec.from)} → ${esc(spec.to)} · start ${money(spec.capital)} · slippage ${spec.slippageBps} bps · tax ${pct(spec.tax?.st, 0)} / ${pct(spec.tax?.lt, 0)}</div></div>
      <div class="row"><label class="row small"><input type="checkbox" id="logScale" ${S.view.log ? "checked" : ""}/> Log scale</label><button class="btn" id="openDir">Open folder</button></div></div>
      <div id="legend"></div><div id="eq"></div>
      <p class="small muted">Growth of the starting capital. Tick runs in the table to compare up to 8; benchmarks are dashed.</p></div>
    <div class="card"><div class="tablewrap"><table id="runsTable"><thead><tr><th></th><th class="l" data-k="label">Run</th>${STAT_COLS.map(([k, l]) => `<th data-k="${k}">${l}${k === sortK ? (sortDir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead><tbody>
      ${sorted.map((r) => `<tr><td><input type="checkbox" data-pick="${esc(r.folder)}" ${S.view.pick.has(r.folder) ? "checked" : ""}/></td><td class="l"><a data-run="${esc(r.folder)}">${esc(r.label)}</a></td>${STAT_COLS.map(([k, , f]) => `<td>${f(r.stats[k])}</td>`).join("")}</tr>`).join("")}
      ${Object.entries(b.benchmarks || {}).map(([t, s]) => `<tr class="bench"><td></td><td class="l">${esc(t)} buy &amp; hold</td>${STAT_COLS.map(([k, , f]) => `<td>${f(s[k])}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div></div>`;
  $("#back").onclick = () => { S.view = null; renderResults(); };
  $("#openDir").onclick = () => api("/api/open", { method: "POST", body: { path: b.path } });
  $("#logScale").onchange = (e) => { S.view.log = e.target.checked; drawBatchChart(b); };
  sortable($("#runsTable"), runs, STAT_COLS, (k, dir) => { S.view.sort = { k, dir }; renderBatch(root); });
  root.querySelectorAll("[data-pick]").forEach((c) => (c.onchange = () => {
    if (c.checked) { if (S.view.pick.size >= 8) { c.checked = false; return toast("Compare up to 8 runs at a time"); } S.view.pick.add(c.dataset.pick); } else S.view.pick.delete(c.dataset.pick);
    drawBatchChart(b);
  }));
  root.querySelectorAll("[data-run]").forEach((a) => (a.onclick = () => { S.view = { ...S.view, run: a.dataset.run }; renderResults(); }));
  drawBatchChart(b);
}
function drawBatchChart(b) {
  const runs = (b.runs || []).filter((r) => S.view.pick.has(r.folder));
  const series = [
    ...runs.map((r, k) => ({ name: r.label, color: SERIES[k % 8], points: b.curves[r.folder] || [] })),
    ...Object.entries(b.bench || {}).map(([t, pts], k) => ({ name: t, color: k ? "--bench2" : "--bench1", dash: true, points: pts })),
  ];
  Charts.legend($("#legend"), series);
  Charts.mount($("#eq"), () => Charts.lineChart($("#eq"), series, { height: 340, log: S.view.log, yFormat: money, label: "Equity curves" }));
}
async function renderRun(root) {
  const d = await api(`/api/results/run?dir=${encodeURIComponent(S.view.batch)}&run=${encodeURIComponent(S.view.run)}`);
  const s = d.summary.stats || {};
  const eq = d.equity;
  let peak = -Infinity;
  const dd = eq.map(([t, v]) => { peak = Math.max(peak, v); return [t, v / peak - 1]; });
  const params = d.summary.params || {};
  root.innerHTML = `<div class="crumbs"><a id="back0">Results</a> › <a id="back1">${esc(S.view.data?.name || S.view.batch)}</a> › <b>${esc(d.summary.label)}</b></div>
    <div class="card"><div class="row spread"><div><h2>${esc(d.summary.label)}</h2><div class="small muted">${esc(s.start)} → ${esc(s.end)} · ${esc(d.summary.strategy)}</div></div>
      <div class="row"><label class="row small"><input type="checkbox" id="logScale" ${S.view.log ? "checked" : ""}/> Log scale</label><button class="btn" id="openDir">Open folder</button></div></div>
      <div class="tiles" style="margin-top:10px">
        ${[["CAGR", pct(s.cagr), `after tax ${pct(s.afterTaxCagr)}`], ["End value", money(s.endValue), `after tax ${money(s.afterTaxEndValue)}`], ["Max drawdown", pct(s.maxDrawdown), `${esc(s.maxDrawdownStart || "")} → ${esc(s.maxDrawdownEnd || "")}`],
           ["Sharpe", num(s.sharpe), `Sortino ${num(s.sortino)}`], ["Volatility", pct(s.volatility), `Calmar ${num(s.calmar)}`], ["Trades", num(s.trades, 0), `win rate ${pct(s.winRate, 0)}`],
           ["Avg win / loss", `${pct(s.avgWin)} / ${pct(s.avgLoss)}`, `profit factor ${num(s.profitFactor)}`], ["Turnover", `${num(s.turnover, 1)}×/yr`, `invested ${pct(s.exposure, 0)} of the time`],
           ["Best / worst month", `${pct(s.bestMonth)} / ${pct(s.worstMonth)}`, `${pct(s.pctPositiveMonths, 0)} of months up`], ["Taxes (est.)", money(s.taxes), `dividends ${money(d.summary.dividends)}`]]
          .map(([k, v, sub]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join("")}
      </div></div>
    <div class="card"><h3>Equity vs benchmarks</h3><div id="legend"></div><div id="eq"></div></div>
    <div class="card"><h3>Drawdown</h3><div id="dd"></div></div>
    <div class="card"><h3>Settings</h3><div class="small" style="columns:3 260px">${Object.keys(params).length ? Object.entries(params).map(([k, v]) => `<div><span class="muted">${esc(k)}</span> ${esc(v)}</div>`).join("") : '<span class="muted">Strategy defaults</span>'}</div></div>
    <div class="card"><div class="row spread"><h3>Trades (${d.trades.length.toLocaleString()})</h3><input id="tFilter" placeholder="Filter by ticker" style="width:160px"/></div><div class="tablewrap" id="trades"></div></div>`;
  $("#back0").onclick = () => { S.view = null; renderResults(); };
  $("#back1").onclick = () => { S.view = { batch: S.view.batch, data: S.view.data, pick: S.view.pick, log: S.view.log }; renderResults(); };
  $("#openDir").onclick = () => api("/api/open", { method: "POST", body: { path: d.path } });
  const series = [{ name: d.summary.label, color: "--s1", points: eq.map(([t, v]) => [t, v]) },
    ...Object.entries(d.bench).map(([t, pts], k) => ({ name: t, color: k ? "--bench2" : "--bench1", dash: true, points: pts }))];
  const draw = () => Charts.lineChart($("#eq"), series, { height: 320, log: S.view.log, yFormat: money, label: "Equity" });
  Charts.legend($("#legend"), series);
  Charts.mount($("#eq"), draw);
  $("#logScale").onchange = (e) => { S.view.log = e.target.checked; draw(); };
  Charts.mount($("#dd"), () => Charts.lineChart($("#dd"), [{ name: "Drawdown", color: "--s8", points: dd }], { height: 180, area: true, zeroLine: true, yFormat: (v) => pct(v, 0), label: "Drawdown" }));
  const cols = [["ticker", "Ticker", (x) => esc(x)], ["entryD", "Entry", (x) => esc(x)], ["exitD", "Exit", (x) => esc(x)], ["days", "Days", (x) => num(x, 0)], ["shares", "Shares", (x) => num(x, 0)],
    ["entry", "Entry $", (x) => num(x)], ["exit", "Exit $", (x) => num(x)], ["ret", "Return", (x) => pct(x)], ["pnl", "P&L", money], ["term", "Term", esc], ["exitTag", "Exit reason", esc]];
  let sortK = "exitD", sortDir = -1, page = 0;
  const drawTrades = () => {
    const f = $("#tFilter").value.trim().toUpperCase();
    const rows = d.trades.filter((t) => !f || String(t.ticker).startsWith(f)).sort((a, b) => sortDir * (a[sortK] > b[sortK] ? 1 : a[sortK] < b[sortK] ? -1 : 0));
    const pages = Math.max(1, Math.ceil(rows.length / 100)); page = Math.min(page, pages - 1);
    $("#trades").innerHTML = `<table><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === "ticker" ? "l" : ""}">${l}${k === sortK ? (sortDir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead><tbody>
      ${rows.slice(page * 100, page * 100 + 100).map((t) => `<tr>${cols.map(([k, , fm]) => `<td class="${k === "ticker" ? "l" : ""} ${k === "pnl" || k === "ret" ? (t[k] < 0 ? "bad" : "good") : ""}">${fm(t[k])}</td>`).join("")}</tr>`).join("")}</tbody></table>
      ${pages > 1 ? `<div class="row" style="padding:8px"><button class="btn small" id="prev" ${page ? "" : "disabled"}>‹</button><span class="small muted">Page ${page + 1} of ${pages}</span><button class="btn small" id="next" ${page < pages - 1 ? "" : "disabled"}>›</button></div>` : ""}`;
    $("#trades").querySelectorAll("th[data-k]").forEach((th) => (th.onclick = () => { sortDir = sortK === th.dataset.k ? -sortDir : -1; sortK = th.dataset.k; drawTrades(); }));
    $("#prev")?.addEventListener("click", () => { page--; drawTrades(); });
    $("#next")?.addEventListener("click", () => { page++; drawTrades(); });
  };
  $("#tFilter").oninput = () => { page = 0; drawTrades(); };
  drawTrades();
}

// ───────── Studies ─────────
// Signal study: every signal's forward return vs the strategy's universe on the same days, by year.
// Several studies can be queued as one batch (one job, one summary CSV).
function studyForm() {
  if (!S.studyForm) S.studyForm = { item: libItems().find((i) => i.strategy === "pullback")?.id ?? libItems()[0]?.id, from: "2005-01-01", to: "2018-12-31", horizons: null, overrides: null, name: "", cost: "0.20", batch: [], batchName: "" };
  return S.studyForm;
}
const signed = (x) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
function studyParams(item, text) {
  const def = stratDef(item.strategy), params = {};
  for (const line of String(text || "").split(/[\n;]+/).map((x) => x.trim()).filter(Boolean)) {
    const i = line.indexOf("=");
    if (i < 1) throw new Error(`"${line}" should look like key=value`);
    const k = line.slice(0, i).trim();
    if (!(k in def.defaults)) throw new Error(`${item.strategy} has no setting "${k}"`);
    params[k] = coerce(line.slice(i + 1).trim(), def.defaults[k]);
  }
  return params;
}
async function renderStudies() {
  const root = $("#tab-studies");
  if (S.study) return renderStudy(root);
  if (!S.studies) { root.innerHTML = '<div class="card empty">Loading…</div>'; S.studies = await api("/api/studies").catch(() => []); }
  const f = studyForm(), items = libItems(), item = items.find((i) => i.id === f.item) ?? items[0];
  if (f.horizons == null) f.horizons = (stratDef(item?.strategy)?.studyHorizons ?? [5, 10, 15]).join(",");
  if (f.overrides == null) f.overrides = Object.entries(item?.params ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  const list = S.studies;
  root.innerHTML = `
    <div class="card"><h2>Signal study</h2>
      <p class="small muted">Takes <b>every</b> entry signal the strategy gives (filled or not, no position limits) and measures the return from the next day's open
        to the close of the Nth session (counting the entry day), against every stock in the strategy's universe (its liquidity filter) on the same signal days.
        Split-adjusted prices, no dividends. <b>Cost-adjusted</b> = signal return minus the cost below (round-trip slippage); a stock that stops trading counts at its last close.</p>
      <div class="row">
        <label class="field">Strategy or preset<select id="stItem">${items.map((i) => `<option value="${esc(i.id)}" ${i.id === item?.id ? "selected" : ""}>${esc(i.kind === "preset" ? `Preset: ${i.name}` : i.name)}</option>`).join("")}</select></label>
        <label class="field">From<input id="stFrom" value="${esc(f.from)}" placeholder="YYYY-MM-DD" style="width:130px"/></label>
        <label class="field">To<input id="stTo" value="${esc(f.to)}" placeholder="YYYY-MM-DD" style="width:130px"/></label>
        <label class="field">Horizons (sessions)<input id="stH" value="${esc(f.horizons)}" style="width:120px"/></label>
        <label class="field">Cost per signal (%)<input id="stCost" value="${esc(f.cost)}" style="width:90px"/></label>
        <label class="field">Name<input id="stName" value="${esc(f.name)}" placeholder="optional" style="width:180px"/></label>
      </div>
      <label class="field" style="margin-top:10px"><span>Setting changes, one per line (e.g. <code>market_ma=200</code>); blank = the strategy's defaults</span>
        <textarea id="stOver" rows="3" style="font-family:ui-monospace,Consolas,monospace;width:100%;max-width:520px">${esc(f.overrides)}</textarea></label>
      <div class="row spread" style="margin-top:12px"><span class="small muted">${item ? esc(item.desc) : ""}</span>
        <div class="row"><button class="btn" id="stAdd" ${item ? "" : "disabled"}>Add to batch</button>
        <button class="btn primary" id="stRun" ${item && S.state.data.ready ? "" : "disabled"}>Run this study</button></div></div>
      ${S.state.data.ready ? "" : '<p class="small warn">Prepare data first (Data tab).</p>'}
    </div>
    ${f.batch.length ? `<div class="card"><div class="row spread"><h2>Batch (${f.batch.length})</h2>
        <div class="row"><label class="field">Batch name<input id="stBName" value="${esc(f.batchName)}" placeholder="Study batch" style="width:180px"/></label>
        <button class="btn" id="stClear">Clear</button><button class="btn primary" id="stRunBatch" ${S.state.data.ready ? "" : "disabled"}>Run batch</button></div></div>
      <p class="small muted">One job, ${esc(f.from || "start")} → ${esc(f.to || "end")}, cost ${esc(f.cost)}% per signal (the From / To / cost above apply to every study). Writes one study per line plus a summary CSV.</p>
      <div class="tablewrap"><table><thead><tr><th class="l">Study</th><th class="l">Strategy</th><th>Horizons</th><th class="l">Settings</th><th></th></tr></thead><tbody>
        ${f.batch.map((b, k) => `<tr><td class="l">${esc(b.name || b.strategy)}</td><td class="l">${esc(b.strategy)}</td><td>${esc(b.horizons)}</td>
          <td class="l small">${esc(Object.entries(b.params).map(([x, v]) => `${x}=${v}`).join(" ")) || '<span class="muted">defaults</span>'}</td>
          <td><button class="btn small danger" data-brm="${k}">Remove</button></td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="card"><div class="row spread"><h2>Past studies</h2><button class="btn" id="stRefresh">Refresh</button></div>
      ${list.length ? `<div class="tablewrap"><table><thead><tr><th class="l">Study</th><th>Period</th><th>Signals</th><th colspan="4">Edge over the universe, after cost (all years)</th><th></th></tr></thead><tbody>
        ${list.map((s) => `<tr><td class="l"><a data-study="${esc(s.dir)}">${esc(s.name)}</a><div class="small muted">${esc(String(s.created).slice(0, 16).replace("T", " "))} · ${s.cost != null ? `cost ${pct(s.cost, 2)}` : "before costs"}${Object.keys(s.params || {}).length ? ` · ${esc(Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(" "))}` : ""}</div></td>
          <td>${esc(s.from)} → ${esc(s.to)}</td><td>${num(s.all?.signals, 0)}</td>
          ${[0, 1, 2, 3].map((k) => { const h = s.horizons?.[k]; if (h == null) return "<td></td>"; const v = s.all?.netEdge?.[k] ?? s.all?.edge?.[k]; return `<td class="${(v ?? 0) >= 0 ? "good" : "bad"}">${signed(v)} <span class="small muted">${h}d</span></td>`; }).join("")}
          <td><button class="btn danger small" data-sdel="${esc(s.dir)}">Delete</button></td></tr>`).join("")}
      </tbody></table></div>` : '<div class="empty">No studies yet.</div>'}</div>`;
  const keep = () => Object.assign(f, { from: $("#stFrom").value.trim(), to: $("#stTo").value.trim(), horizons: $("#stH").value.trim(), overrides: $("#stOver").value, name: $("#stName").value.trim(), cost: $("#stCost").value.trim() });
  const current = () => ({ strategy: item.strategy, params: studyParams(item, f.overrides), horizons: f.horizons, name: f.name || (item.kind === "preset" ? item.name : "") });
  $("#stItem").onchange = (e) => { keep(); f.item = e.target.value; f.overrides = null; f.horizons = null; renderStudies(); };
  $("#stRefresh").onclick = () => { S.studies = null; renderStudies(); };
  root.querySelectorAll("[data-study]").forEach((a) => (a.onclick = () => { S.study = { dir: a.dataset.study }; renderStudies(); }));
  root.querySelectorAll("[data-sdel]").forEach((b) => (b.onclick = async () => { if (!confirm("Delete this study from disk?")) return; await api(`/api/studies?dir=${encodeURIComponent(b.dataset.sdel)}`, { method: "DELETE" }); S.studies = null; renderStudies(); }));
  root.querySelectorAll("[data-brm]").forEach((b) => (b.onclick = () => { keep(); f.batch.splice(Number(b.dataset.brm), 1); renderStudies(); }));
  $("#stAdd").onclick = () => { keep(); try { f.batch.push(current()); f.name = ""; renderStudies(); } catch (e) { toast(e.message, 6000); } };
  $("#stRun").onclick = () => { keep(); try { startJob({ kind: "study", ...current(), from: f.from, to: f.to, cost: f.cost }); } catch (e) { toast(e.message, 6000); } };
  if ($("#stClear")) $("#stClear").onclick = () => { keep(); f.batch = []; renderStudies(); };
  if ($("#stRunBatch")) $("#stRunBatch").onclick = () => {
    keep(); f.batchName = $("#stBName").value.trim();
    startJob({ kind: "study-batch", name: f.batchName, from: f.from, to: f.to, cost: f.cost, studies: f.batch });
  };
}
async function renderStudy(root) {
  const s = S.study.data ?? (S.study.data = await api(`/api/studies/one?dir=${encodeURIComponent(S.study.dir)}`));
  const H = s.horizons, hasNet = !!s.rows?.[0]?.net;
  const cell = (x, edge) => `<td class="${edge ? (x == null ? "" : x >= 0 ? "good" : "bad") : ""}">${signed(x)}</td>`;
  const head = (lbl) => H.map((h) => `<th>${lbl} ${h}d</th>`).join("");
  const body = (fn) => s.rows.map((r) => `<tr class="${r.year === "All" ? "total" : ""}"><td class="l">${r.year === "All" ? "<b>All years</b>" : esc(r.year)}</td>${fn(r)}</tr>`).join("");
  root.innerHTML = `<div class="crumbs"><a id="stBack">Studies</a> › <b>${esc(s.name)}</b></div>
    <div class="card"><div class="row spread"><div><h2>${esc(s.name)}</h2>
      <div class="small muted">${esc(s.strategy)} · ${esc(s.from)} → ${esc(s.to)} · ${Object.keys(s.params || {}).length ? esc(Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(", ")) : "default settings"}${hasNet ? ` · cost ${pct(s.cost, 2)} per signal` : ""}</div></div>
      <button class="btn" id="stOpen">Open folder</button></div>
      <p class="small muted">Average return from the next day's open to the close of session N. <b>Signal</b>: every signal that day. <b>Universe</b>: every stock passing the
        liquidity filter on the same signal days. <b>Edge</b> = signal − universe.${hasNet ? ` <b>Cost-adjusted</b> = signal − ${pct(s.cost, 2)}; <b>Edge after cost</b> = cost-adjusted − universe.` : ""}</p>
      <div class="tablewrap"><table class="study"><thead><tr><th class="l">Year</th><th>Signals</th><th>Signal days</th>${head("Signal")}${hasNet ? head("Cost-adj.") : ""}${head("Universe")}${head("Edge")}${hasNet ? head("Edge after cost") : ""}</tr></thead>
        <tbody>${body((r) => `<td>${num(r.signals, 0)}</td><td>${num(r.signalDays, 0)}</td>${r.sig.map((x) => cell(x)).join("")}${hasNet ? r.net.map((x) => cell(x)).join("") : ""}${r.base.map((x) => cell(x)).join("")}${r.edge.map((x) => cell(x, true)).join("")}${hasNet ? r.netEdge.map((x) => cell(x, true)).join("") : ""}`)}</tbody></table></div>
    </div>
    <div class="card"><h3>Share of positive returns</h3><div class="tablewrap"><table class="study"><thead><tr><th class="l">Year</th>${head("Signal")}${hasNet ? head("Cost-adj.") : ""}${head("Universe")}</tr></thead>
      <tbody>${body((r) => `${r.sigWin.map((x) => `<td>${pct(x, 0)}</td>`).join("")}${hasNet ? r.netWin.map((x) => `<td>${pct(x, 0)}</td>`).join("") : ""}${r.baseWin.map((x) => `<td>${pct(x, 0)}</td>`).join("")}`)}</tbody></table></div>
      <p class="small muted">${num(s.noEntry?.signals, 0)} signals had no bar the next day and were left out. Every signal's returns are in signals.csv in the folder.</p></div>
    ${(() => {
      const groups = [...new Set(s.rows.flatMap((r) => Object.keys(r.extra || {})))];
      if (!groups.length) return "";
      return `<div class="card"><h3>More groups</h3><p class="small muted">Average return from the entry open to the close of session N, per group (the "minus" rows are differences).</p>
        ${groups.map((g) => `<h4 style="margin:12px 0 6px">${esc(g.replace(/_/g, " "))}</h4><div class="tablewrap"><table class="study"><thead><tr><th class="l">Year</th><th>Count</th>${head("Avg")}</tr></thead>
          <tbody>${body((r) => `<td>${num(r.extra?.[g]?.n, 0)}</td>${(r.extra?.[g]?.avg || []).map((x) => cell(x, g.includes("minus"))).join("")}`)}</tbody></table></div>`).join("")}</div>`;
    })()}`;
  $("#stBack").onclick = () => { S.study = null; renderStudies(); };
  $("#stOpen").onclick = () => api("/api/open", { method: "POST", body: { path: s.path } });
}

// ───────── start ─────────
(async () => {
  await refresh();
  connectEvents();
  setTab(["data", "strategies", "jobs", "results", "studies"].includes(location.hash.slice(1)) ? location.hash.slice(1) : S.state.data.ready ? "strategies" : "data");
})().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<div class="card err">Couldn't load: ${esc(e.message)}</div>`); });
