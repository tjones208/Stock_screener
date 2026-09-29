import { cronRoute } from "@/lib/cron";
import { db } from "@/lib/db";
import { momentumBuild, repairSplits, syncHolidays, syncSplits } from "@/lib/momentum/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Tue–Sat 10:15 UTC, after the EOD load: splits → split repairs → validation, universe, signals,
// ranking snapshot and regime for the latest trading day (monthly / weekly / daily by the calendar).
export const GET = cronRoute("momentum", async () => {
  const end = Date.now() + 270_000;
  const left = () => end - Date.now();
  const { count } = await db().from("ss_market_holidays").select("d", { count: "exact", head: true });
  const holidays = count ? null : await syncHolidays();
  const splits = await syncSplits();
  // Leave ~90 s for the build.
  const repairs = await repairSplits(() => left() - 90_000);
  return { holidays, splits, repairs, build: await momentumBuild() };
});
