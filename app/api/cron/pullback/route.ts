import { cronRoute } from "@/lib/cron";
import { pullbackJob } from "@/lib/pullback/scan";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

// Tue–Sat 10:20 UTC, after the bars and indicators: scan the latest close for the pullback
// strategy and push the next session's buys and exits (no push when there is nothing to do).
export const GET = cronRoute("pullback", pullbackJob);
