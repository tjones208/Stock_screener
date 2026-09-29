import { cronRoute } from "@/lib/cron";
import { nightlyEod } from "@/lib/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Tue–Sat ≈ 6am ET: load the previous trading day's bars and recompute indicators.
// The weekly ticker-list refresh runs separately (/api/cron/tickers): together they exceeded
// the 300s function limit and the job was killed.
export const GET = cronRoute("eod", async () => ({ eod: await nightlyEod() }));
