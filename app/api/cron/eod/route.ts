import { cronRoute } from "@/lib/cron";
import { nightlyEod } from "@/lib/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Tue–Sat ≈ 6:05am ET: load the previous trading day's bars. Indicators are recomputed inside
// Postgres at 6:10 (ss-indicators pg_cron job), which no request timeout can cut short.
// The weekly ticker-list refresh runs separately (/api/cron/tickers): together they exceeded
// the 300s function limit and the job was killed.
export const GET = cronRoute("eod", async () => ({ eod: await nightlyEod() }));
