import { cronRoute } from "@/lib/cron";
import { db } from "@/lib/db";
import { nightlyEod, syncTickers } from "@/lib/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Tue–Sat ≈ 6am ET: load the previous trading day's bars and recompute indicators.
export const GET = cronRoute("eod", async () => {
  const { count } = await db().from("ss_tickers").select("ticker", { count: "exact", head: true });
  // First run of the trading week (Tuesday morning, loading Monday) also refreshes the ticker list.
  const weekly = new Date().getUTCDay() === 2;
  const tickers = !count || weekly ? await syncTickers() : null;
  return { tickers, eod: await nightlyEod() };
});
