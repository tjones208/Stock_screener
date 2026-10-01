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
export function formatSellPush(today: string, sells: SellLine[], openLots: number, assigned: AssignLine[] = [], warnings: string[] = []) {
  const m = formatSells(today, sells, openLots, assigned);
  return warnings.length ? { title: m.title, body: [...warnings, m.body].join("\n") } : m;
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
