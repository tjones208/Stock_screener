import { cronRoute } from "@/lib/cron";
import { backfill, syncTickers } from "@/lib/jobs";
import { db } from "@/lib/db";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Loads missing history ~20 days per call (5 calls/min). Call repeatedly until remaining = 0.
export const GET = cronRoute("backfill", async () => {
  const { count } = await db().from("ss_tickers").select("ticker", { count: "exact", head: true });
  const tickers = count ? null : await syncTickers();
  return { tickers, ...(await backfill(tickers ? 120_000 : 270_000)) };
});
