import { cronRoute } from "@/lib/cron";
import { momentumDryRun } from "@/lib/momentum/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// On demand (?t=YYYY-MM-DD): rebuild and re-plan a signal date with the current code, writing nothing.
export const GET = cronRoute("momentum-dry", async (req) => {
  const t = new URL(req.url).searchParams.get("t");
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return { error: "pass ?t=YYYY-MM-DD" };
  return momentumDryRun(t);
});
