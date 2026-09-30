// Text of the morning momentum push (pure, tested).
import { TRIGGER_LABEL } from "./stops.ts";

export type SellLine = { ticker: string; shares_to_sell: number; exit_trigger: number; urgent: boolean; deadline: string | null; note: string | null };

export function formatSellPush(today: string, sells: SellLine[], openLots: number) {
  const day = new Date(today + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  if (!sells.length) {
    return { title: `Momentum ${day}: no sells`, body: openLots ? `Hold all ${openLots} lot${openLots === 1 ? "" : "s"}; stops are updated on the Momentum tab.` : "No open positions." };
  }
  const lines = sells.slice(0, 6).map((s) => {
    const when = s.urgent && s.exit_trigger !== 4 ? "today" : `by ${s.deadline}`;
    return `SELL ${s.ticker} ${s.shares_to_sell} sh (${when}): ${TRIGGER_LABEL[s.exit_trigger] ?? "exit"}${s.note ? ` — ${s.note}` : ""}`;
  });
  if (sells.length > 6) lines.push(`+${sells.length - 6} more on the Momentum tab`);
  return { title: `Momentum ${day}: ${sells.length} sell${sells.length === 1 ? "" : "s"} at 9:45`, body: lines.join("\n") };
}
