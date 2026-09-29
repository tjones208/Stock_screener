import { cronRoute } from "@/lib/cron";
import { backfill, syncTickers } from "@/lib/jobs";
import { db } from "@/lib/db";
import { newsSweep, repairSplits } from "@/lib/momentum/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Loads missing history ~20 days per call (5 calls/min). Call repeatedly until remaining = 0.
// Once history is complete it spends up to ~2 minutes per run on split repairs and the momentum
// news sweep (the fundamentals job pauses meanwhile, so the two share the rate limit).
export const GET = cronRoute("backfill", async () => {
  const { count } = await db().from("ss_tickers").select("ticker", { count: "exact", head: true });
  const tickers = count ? null : await syncTickers();
  const history = await backfill(tickers ? 120_000 : 270_000);
  if (history.loaded || history.remaining || history.aboveOldCapFilled) return { tickers, ...history };
  const end = Date.now() + 120_000;
  const left = () => end - Date.now();
  const repairs = await repairSplits(left);
  const news = await newsSweep(left).catch((e) => ({ error: String(e) }));
  return { tickers, ...history, repairs, news };
});
