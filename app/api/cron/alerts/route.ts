import { cronRoute } from "@/lib/cron";
import { runAlerts } from "@/lib/jobs";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

// Tue–Sat 10:25 UTC, after the EOD load and the momentum job: evaluate alert rules and push.
export const GET = cronRoute("alerts", async () => ({ alerts: await runAlerts() }));
