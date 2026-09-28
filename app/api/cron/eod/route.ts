import { cronRoute } from "@/lib/cron";
import { db } from "@/lib/db";
import { nightlyEod, syncTickers } from "@/lib/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Weeknights after the close: load today's bars and recompute indicators.
// Mondays (or on first run) also refresh the ticker list and S&P 500 membership first.
export const GET = cronRoute("eod", async () => {
  const { count } = await db().from("ss_tickers").select("ticker", { count: "exact", head: true });
  const monday = new Date().getUTCDay() === 1;
  const tickers = !count || monday ? await syncTickers() : null;
  return { tickers, eod: await nightlyEod() };
});
