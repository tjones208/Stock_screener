"use client";
import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart,
  type IChartApi, type UTCTimestamp,
} from "lightweight-charts";
import { emaSeries, smaSeries } from "@/lib/indicators";

export type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };

const RANGES = [
  { label: "3M", bars: 63 },
  { label: "6M", bars: 126 },
  { label: "1Y", bars: 252 },
  { label: "All", bars: 0 },
];

const toTime = (d: string) => (Date.parse(d + "T00:00:00Z") / 1000) as UTCTimestamp;

type PriceLine = { price: number; title: string };
// Shared empty default so the chart effect doesn't rebuild on every render.
const NO_LINES: PriceLine[] = [];

/** Candles with EMA21 / SMA50 / SMA200 and optional dashed price lines (e.g. a stop). */
export function PriceChart({ bars, lines = NO_LINES }: { bars: Bar[]; lines?: PriceLine[] }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [range, setRange] = useState(126);

  useEffect(() => {
    if (!el.current || !bars.length) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: "#121821" }, textColor: "#8b98a8", attributionLogo: true },
      grid: { vertLines: { color: "#1b2430" }, horzLines: { color: "#1b2430" } },
      rightPriceScale: { borderColor: "#243040" },
      timeScale: { borderColor: "#243040" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350", wickUpColor: "#26a69a", wickDownColor: "#ef5350", borderVisible: false,
    });
    candles.setData(bars.map((b) => ({ time: toTime(b.d), open: b.o, high: b.h, low: b.l, close: b.c })));

    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(bars.map((b) => ({ time: toTime(b.d), value: b.v, color: b.c >= b.o ? "rgba(38,166,154,.45)" : "rgba(239,83,80,.45)" })));

    const closes = bars.map((b) => b.c);
    const overlay = (vals: (number | null)[], color: string) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(bars.flatMap((b, i) => (vals[i] == null ? [] : [{ time: toTime(b.d), value: vals[i]! }])));
    };
    overlay(emaSeries(closes, 21), "#f5a524");
    overlay(smaSeries(closes, 50), "#4da3ff");
    overlay(smaSeries(closes, 200), "#b180ff");

    for (const s of lines) {
      candles.createPriceLine({ price: s.price, color: "#26a69a", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: s.title });
    }
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, lines]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !bars.length) return;
    if (!range || range >= bars.length) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleLogicalRange({ from: bars.length - range, to: bars.length + 2 });
  }, [range, bars]);

  if (!bars.length) return <div className="panel muted">No price history yet.</div>;
  return (
    <div className="panel" style={{ padding: 8 }}>
      <div className="row spread" style={{ marginBottom: 6 }}>
        <div className="row">
          {RANGES.map((r) => (
            <button key={r.label} className={range === r.bars ? "" : "ghost"} onClick={() => setRange(r.bars)} style={{ padding: "4px 10px", minHeight: 30 }}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ fontSize: 11 }}>
          <span style={{ color: "#f5a524" }}>EMA21</span>
          <span style={{ color: "#4da3ff" }}>SMA50</span>
          <span style={{ color: "#b180ff" }}>SMA200</span>
        </div>
      </div>
      <div ref={el} className="chart" />
    </div>
  );
}
