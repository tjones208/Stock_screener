import { cronRoute } from "@/lib/cron";
import { momentumMorningPush } from "@/lib/momentum/notify";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Mon–Fri 11:45 UTC (7:45 ET in summer, 6:45 in winter), after the 10:15 momentum job:
// push today's sells and why, or "no sells". Skips weekends and market holidays.
export const GET = cronRoute("momentum-notify", momentumMorningPush);
