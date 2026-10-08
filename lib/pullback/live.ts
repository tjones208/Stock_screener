// Pure parts of the live pullback strategy (no I/O): trade P&L, sizing equity, exit checks on the
// latest bar, and the morning push text. Used by lib/pullback/scan.ts and the Pullback tab.
import { tradingDaysBetween, type Calendar } from "../momentum/calendar.ts";
import { Hist, pbHistoryBars, type PbParams } from "./core.ts";

export type PbSettings = { params: PbParams; account_value: number | null; account_set_at: string | null };

export type PbTrade = {
  id: number; ticker: string; signal_d: string | null; entry_d: string; entry: number; shares: number; stop: number; target: number;
  exit_d: string | null; exit: number | null; exit_reason: string | null; note: string | null;
};

export const tradePnl = (t: PbTrade) => (t.exit == null ? 0 : (Number(t.exit) - Number(t.entry)) * Number(t.shares));

/** Sizing equity: the account value you set plus P&L from trades closed since you set it. */
export function pbEquity(s: PbSettings, trades: PbTrade[]) {
  if (s.account_value == null) return null;
  const since = s.account_set_at?.slice(0, 10) ?? "";
  return s.account_value + trades.filter((t) => t.exit_d && t.exit_d >= since).reduce((a, t) => a + tradePnl(t), 0);
}

export type Bars = { ticker: string; d: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };

export function histOf(b: Bars, p: PbParams) {
  const h = new Hist(p, pbHistoryBars(p));
  for (let i = 0; i < b.d.length; i++) h.push({ c: b.c[i], h: b.h[i], l: b.l[i], dv: b.c[i] * b.v[i] });
  return h;
}

export type ExitStatus = {
  id: number; ticker: string; d: string | null; close: number | null; low: number | null; high: number | null; maFast: number | null;
  held: number; action: "EXIT" | "HOLD" | "NO DATA"; reason: string | null; note: string; unrealized: number | null;
};

export const EXIT_LABEL: Record<string, string> = {
  stop: "Stop traded", target: "Target traded", close_below_ma: "Closed under the fast MA", time_stop: "Time stop", manual: "Manual",
};

/** Exit checks on the latest bar for each open trade (the backtest's rules, read off the close). */
export function exitStatus(t: PbTrade, b: Bars | undefined, cal: Calendar, p: PbParams): ExitStatus {
  const base = { id: t.id, ticker: t.ticker, d: null, close: null, low: null, high: null, maFast: null, held: 0, unrealized: null };
  if (!b?.d.length) return { ...base, action: "NO DATA", reason: null, note: "No recent bars." };
  const i = b.d.length - 1, d = b.d[i];
  const h = histOf(b, p);
  const held = t.entry_d <= d ? tradingDaysBetween(cal, t.entry_d, d) + 1 : 0;
  const s = { ...base, d, close: b.c[i], low: b.l[i], high: b.h[i], maFast: Number.isFinite(h.maFast) ? h.maFast : null, held, unrealized: (b.c[i] - t.entry) * t.shares };
  if (held === 0) return { ...s, action: "HOLD", reason: null, note: "Bought after the last close." };
  if (b.l[i] <= t.stop) return { ...s, action: "EXIT", reason: "stop", note: `Low ${b.l[i].toFixed(2)} reached the stop. If your stop order didn't fill, sell at the open.` };
  if (b.h[i] >= t.target) return { ...s, action: "EXIT", reason: "target", note: `High ${b.h[i].toFixed(2)} reached the target. If your limit didn't fill, sell at the open.` };
  if (p.exit_on_close_below_fast_ma && Number.isFinite(h.maFast) && b.c[i] < h.maFast) {
    return { ...s, action: "EXIT", reason: "close_below_ma", note: `Closed ${b.c[i].toFixed(2)} under the ${p.fast_ma}-day average ${h.maFast.toFixed(2)}: sell at the open.` };
  }
  if (held >= p.max_hold_days) return { ...s, action: "EXIT", reason: "time_stop", note: `Held ${held} sessions (limit ${p.max_hold_days}): sell at the open.` };
  return { ...s, action: "HOLD", reason: null, note: `Session ${held} of ${p.max_hold_days}.` };
}

export type BuyRow = {
  ticker: string; rs: number; close: number; stop: number; target: number; stop_pct: number;
  shares: number | null; risk: number | null; value: number | null; entry_min: number; entry_max: number; skip: string | null;
};
const fmt = (x: number) => x.toFixed(2);
const shortDate = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });

/** Push text: actionable buys and exits for the next session, or null when there's nothing to do. */
export function pushText(scan: { trade_d: string; buys: BuyRow[]; exits: ExitStatus[] }) {
  const buys = scan.buys.filter((b) => b.shares && !b.skip);
  const exits = scan.exits.filter((x) => x.action === "EXIT");
  if (!buys.length && !exits.length) return null;
  const parts = [buys.length ? `${buys.length} buy${buys.length > 1 ? "s" : ""}` : "", exits.length ? `${exits.length} exit${exits.length > 1 ? "s" : ""}` : ""].filter(Boolean);
  const lines = [
    ...exits.map((x) => `SELL ${x.ticker}: ${EXIT_LABEL[x.reason ?? ""] ?? x.reason}`),
    ...buys.map((b) => `BUY ${b.ticker} ${b.shares} sh, stop ${fmt(b.stop)}, target ${fmt(b.target)} (open ${fmt(b.entry_min)}–${fmt(b.entry_max)})`),
  ];
  return { title: `Pullback: ${parts.join(", ")} for ${shortDate(scan.trade_d)}`, body: lines.join("\n") };
}

