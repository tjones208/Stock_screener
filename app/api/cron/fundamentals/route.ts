import { cronRoute } from "@/lib/cron";
import { db } from "@/lib/db";
import { fundamentalsBatch } from "@/lib/jobs";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Called every minute by pg_cron: 1 ticker × 3 Massive calls (details, income statements, balance
// sheet) stays under 5 calls/min and inside the 60 s limit.
// Waits while the history backfill is running so the two don't fight over the rate limit.
export const GET = cronRoute("fundamentals", async () => {
  const { count } = await db().from("ss_loaded_days").select("d", { count: "exact", head: true });
  if ((count ?? 0) < 250) return { skipped: "backfill in progress", daysLoaded: count ?? 0 };
  const { count: partial } = await db().from("ss_loaded_days").select("d", { count: "exact", head: true }).eq("full_universe", false);
  if ((partial ?? 0) > 0) return { skipped: "above-$75 history fill in progress", daysLeft: partial };
  // Momentum upkeep (news sweep, split repairs) uses the same Massive rate limit.
  const { count: busy } = await db().from("ss_job_runs").select("id", { count: "exact", head: true })
    .in("job", ["backfill", "momentum"]).is("finished_at", null).gte("started_at", new Date(Date.now() - 6 * 60_000).toISOString());
  if (busy) return { skipped: "momentum upkeep running" };
  return fundamentalsBatch(1);
});
