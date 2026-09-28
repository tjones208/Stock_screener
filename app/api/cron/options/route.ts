import { cronRoute } from "@/lib/cron";
import { runAlerts, scanOptions } from "@/lib/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Weeknights, after the EOD job: scan put chains, then evaluate alerts and push.
export const GET = cronRoute("options", async () => {
  const options = await scanOptions(230_000);
  const alerts = await runAlerts();
  return { options, alerts };
});
