// Text of the morning momentum push (pure, tested).
import { TRIGGER_LABEL } from "./stops.ts";

export type SellLine = { ticker: string; shares_to_sell: number; exit_trigger: number; urgent: boolean; deadline: string | null; note: string | null };

export type AssignLine = { ticker: string; contracts: number; strike: number };

/** "⚠ Earnings unchecked" line for the morning push, or null when every buy order today was screened. */
export function earningsWarning(uncheckedBuys: number): string | null {
  if (!uncheckedBuys) return null;
  return `⚠ Earnings unchecked: ${uncheckedBuys} buy order${uncheckedBuys === 1 ? "" : "s"} today ${uncheckedBuys === 1 ? "wasn't" : "weren't"} screened for earnings — check each before buying`;
}

/** Warning lines (earnings unchecked, new buys blocked) lead the body so they show in the notification preview. */
export function formatSellPush(today: string, sells: SellLine[], openLots: number, assigned: AssignLine[] = [], warnings: string[] = [], notes: string[] = []) {
  const m = formatSells(today, sells, openLots, assigned);
  return warnings.length || notes.length ? { title: m.title, body: [...warnings, m.body, ...notes].join("\n") } : m;
}

/** "Update GTC stop" lines: disaster stop ≥ 2% above what's posted at the broker (any day). */
export function gtcLines(lots: { ticker: string; disaster_stop: number; disaster_posted: number | null }[]) {
  const by = new Map<string, number>();
  for (const l of lots) {
    if (l.disaster_posted != null && l.disaster_stop < l.disaster_posted * 1.02 - 1e-9) continue;
    by.set(l.ticker, Math.max(by.get(l.ticker) ?? 0, l.disaster_stop));
  }
  return [...by].map(([t, v]) => `Update GTC stop ${t} → ${v.toFixed(2)}`);
}

/** Volatility-brake line: m and what it does today. */
export function volLine(m: number, trimBelow: number) {
  if (m >= 0.999) return null;
  return `Volatility brake m = ${m.toFixed(2)}: new buys at ${Math.round(m * 100)}% of target${m < trimBelow ? "; trims on weekly / month-end signals" : ""}.`;
}

/** Month-end lines: kill switch (strategy trails MTUM after tax over 12 months) and idle cash. */
export function monthEndLines(a: { kill: { active: boolean; mine: number | null; mtum: number | null }; idle: number; cashEtf: string }) {
  const out: string[] = [];
  if (a.kill.active) {
    out.push(`Kill switch: 12-month after-tax return ${(100 * (a.kill.mine ?? 0)).toFixed(1)}% trails MTUM ${(100 * (a.kill.mtum ?? 0)).toFixed(1)}%. Consider the ETF version.`);
  }
  if (a.idle > 0) out.push(`Idle cash $${Math.round(a.idle).toLocaleString("en-US")}: park it in ${a.cashEtf} or confirm the broker cash sweep.`);
  return out;
}

/** True when `now` is 10:30 ET (any minute 10:25–10:44) on a weekday; cron fires at both UTC offsets. */
export function isUrgentAlertTime(now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24, mi = Number(p.minute);
  return !["Sat", "Sun"].includes(p.weekday) && h === 10 && mi >= 25 && mi < 45;
}

/** 10:30 ET reminder: urgent sells still open. Null when there are none. */
export function formatUrgentPush(sells: SellLine[]) {
  const urgent = sells.filter((s) => s.urgent);
  if (!urgent.length) return null;
  return {
    title: `Momentum: ${urgent.length} urgent sell${urgent.length === 1 ? "" : "s"} still open`,
    body: urgent.slice(0, 6).map((s) => `SELL ${s.ticker} ${s.shares_to_sell} sh: ${TRIGGER_LABEL[s.exit_trigger] ?? "exit"}${s.note ? ` — ${s.note}` : ""}`).join("\n")
      + (urgent.length > 6 ? `\n+${urgent.length - 6} more on the Momentum tab` : ""),
  };
}

function formatSells(today: string, sells: SellLine[], openLots: number, assigned: AssignLine[]) {
  const day = new Date(today + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const called = assigned.map((a) => `CALLED AWAY? ${a.ticker} ${a.contracts * 100} sh at ${a.strike}: confirm on the Momentum tab`);
  if (!sells.length && called.length) {
    return { title: `Momentum ${day}: ${called.length} covered call${called.length === 1 ? "" : "s"} assigned?`, body: called.join("\n") };
  }
  if (!sells.length) {
    return { title: `Momentum ${day}: no sells`, body: openLots ? `Hold all ${openLots} lot${openLots === 1 ? "" : "s"}; stops are updated on the Momentum tab.` : "No open positions." };
  }
  const lines = sells.slice(0, 6).map((s) => {
    const when = s.urgent && s.exit_trigger !== 4 ? "today" : `by ${s.deadline}`;
    return `SELL ${s.ticker} ${s.shares_to_sell} sh (${when}): ${TRIGGER_LABEL[s.exit_trigger] ?? "exit"}${s.note ? ` — ${s.note}` : ""}`;
  });
  if (sells.length > 6) lines.push(`+${sells.length - 6} more on the Momentum tab`);
  lines.push(...called);
  return { title: `Momentum ${day}: ${sells.length} sell${sells.length === 1 ? "" : "s"} at 9:45`, body: lines.join("\n") };
}
