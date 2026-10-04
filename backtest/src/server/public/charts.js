// Small SVG line chart: time on x, one value axis, 2px lines, direct end labels, crosshair tooltip.
// Series colors come from CSS tokens (--s1…--s8, --bench1/2) so light and dark modes both work.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  function niceTicks(lo, hi, n = 5) {
    const span = hi - lo || Math.abs(hi) || 1;
    const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function logTicks(lo, hi) {
    const out = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo && v <= hi) out.push(v); }
    return out.length >= 2 ? out : niceTicks(lo, hi);
  }
  const DAY = 86400000;
  const parse = (d) => (typeof d === "number" ? d : Date.parse(d + "T00:00:00Z"));
  const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);

  /**
   * series: [{ name, color (css var name or value), dash, points: [[date, value], …] }]
   * opts: { height, yFormat(v), log, area (fill under the first series to 0), zeroLine }
   */
  function lineChart(host, series, opts = {}) {
    host.innerHTML = "";
    host.classList.add("chart");
    const data = series.map((s) => ({ ...s, pts: s.points.map(([d, v]) => [parse(d), v]).filter(([, v]) => Number.isFinite(v) && (!opts.log || v > 0)) })).filter((s) => s.pts.length);
    if (!data.length) { host.innerHTML = '<div class="empty">No data</div>'; return; }
    const W = host.clientWidth || 800, H = opts.height || 300;
    const labelsRight = data.length <= 6;
    const M = { l: 64, r: labelsRight ? 170 : 16, t: 10, b: 26 };
    const xs = data.flatMap((s) => s.pts.map((p) => p[0])), ys = data.flatMap((s) => s.pts.map((p) => p[1]));
    let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 === x0) x1 = x0 + DAY;
    let y0 = Math.min(...ys, opts.zeroLine ? 0 : Infinity), y1 = Math.max(...ys, opts.zeroLine ? 0 : -Infinity);
    if (opts.log) { y0 = y0 * 0.95; y1 = y1 * 1.05; } else { const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.05 || 1; y0 -= opts.zeroLine && y0 === 0 ? 0 : pad; y1 += opts.zeroLine && y1 === 0 ? 0 : pad; }
    const X = (t) => M.l + ((t - x0) / (x1 - x0)) * (W - M.l - M.r);
    const Y = opts.log ? (v) => M.t + (1 - (Math.log(v) - Math.log(y0)) / (Math.log(y1) - Math.log(y0))) * (H - M.t - M.b)
                       : (v) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
    const fmt = opts.yFormat || ((v) => v.toLocaleString());
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.label || "chart" }, host);
    const g = el("g", {}, svg);
    // Grid and axes (recessive).
    for (const v of opts.log ? logTicks(y0, y1) : niceTicks(y0, y1)) {
      el("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), stroke: css("--grid"), "stroke-width": 1 }, g);
      const t = el("text", { x: M.l - 8, y: Y(v) + 4, "text-anchor": "end", "font-size": 11, fill: css("--muted") }, g);
      t.textContent = fmt(v);
    }
    if (opts.zeroLine) el("line", { x1: M.l, x2: W - M.r, y1: Y(0), y2: Y(0), stroke: css("--muted"), "stroke-width": 1 }, g);
    const yrs = (x1 - x0) / (365.25 * DAY);
    const stepY = yrs > 12 ? 2 : 1;
    for (let y = new Date(x0).getUTCFullYear() + 1; ; y += stepY) {
      const t = Date.UTC(y, 0, 1); if (t > x1) break;
      if (yrs < 1.2) break;
      const tx = el("text", { x: X(t), y: H - 6, "text-anchor": "middle", "font-size": 11, fill: css("--muted") }, g);
      tx.textContent = String(y);
    }
    if (yrs < 1.2) for (const t of [x0, x1]) { const tx = el("text", { x: X(t), y: H - 6, "text-anchor": t === x0 ? "start" : "end", "font-size": 11, fill: css("--muted") }, g); tx.textContent = fmtDate(t); }
    // Series.
    const color = (c) => (c.startsWith("--") ? css(c) : c);
    data.forEach((s, k) => {
      const d = s.pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      if (opts.area && k === 0) el("path", { d: `${d}L${X(s.pts.at(-1)[0])},${Y(0)}L${X(s.pts[0][0])},${Y(0)}Z`, fill: color(s.color), "fill-opacity": 0.18, stroke: "none" }, g);
      el("path", { d, fill: "none", stroke: color(s.color), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", ...(s.dash ? { "stroke-dasharray": "5 4" } : {}) }, g);
    });
    // Direct labels at the line ends, nudged apart.
    if (labelsRight) {
      const ends = data.map((s) => ({ s, y: Y(s.pts.at(-1)[1]) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      for (const e of ends) {
        const t = el("text", { x: W - M.r + 8, y: e.y + 4, "font-size": 11, fill: css("--text-2") }, g);
        // Middle ellipsis keeps the part that tells similar runs apart (usually the end).
        const n = e.s.name;
        t.textContent = n.length > 26 ? `${n.slice(0, 10)}…${n.slice(-15)}` : n;
        if (n.length > 26) { const ti = el("title", {}, t); ti.textContent = n; }
      }
    }
    // Hover: crosshair, dots, tooltip.
    const cross = el("line", { y1: M.t, y2: H - M.b, stroke: css("--muted"), "stroke-width": 1, visibility: "hidden" }, g);
    const dots = data.map((s) => el("circle", { r: 4, fill: color(s.color), stroke: css("--surface"), "stroke-width": 2, visibility: "hidden" }, g));
    const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; host.appendChild(tip);
    const hit = el("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: "transparent" }, svg);
    const nearest = (pts, t) => { let lo = 0, hi = pts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m][0] < t) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(pts[lo - 1][0] - t) < Math.abs(pts[lo][0] - t) ? pts[lo - 1] : pts[lo]; };
    hit.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      const rows = data.map((s, k) => { const p = nearest(s.pts, t); dots[k].setAttribute("cx", X(p[0])); dots[k].setAttribute("cy", Y(p[1])); dots[k].setAttribute("visibility", "visible"); return { s, p }; });
      tip.innerHTML = `<div class="muted">${fmtDate(rows[0].p[0])}</div>` + rows.sort((a, b) => b.p[1] - a.p[1]).map(({ s, p }) =>
        `<div><span class="sw" style="background:${color(s.color)}"></span>${s.name}: <b>${fmt(p[1])}</b></div>`).join("");
      tip.hidden = false;
      const left = (px / W) * r.width;
      tip.style.left = `${Math.min(left + 14, r.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${8}px`;
    });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); });
  }

  function legend(host, series) {
    host.className = "legend";
    host.innerHTML = series.map((s) => `<span><span class="sw${s.dash ? " dash" : ""}" style="background:${s.color.startsWith("--") ? `var(${s.color})` : s.color};color:${s.color.startsWith("--") ? `var(${s.color})` : s.color}"></span>${s.name}</span>`).join("");
  }

  // Redraw charts when their container is resized.
  const ro = new ResizeObserver((entries) => { for (const e of entries) e.target.__redraw?.(); });
  function mount(host, draw) { host.__redraw = draw; ro.observe(host); draw(); }

  // Theme change: redraw so the colors follow light / dark.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => document.querySelectorAll(".chart").forEach((c) => c.__redraw?.()));

  window.Charts = { lineChart, legend, mount };
})();
