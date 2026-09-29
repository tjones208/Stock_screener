import { cronRoute } from "@/lib/cron";
import { syncTickers } from "@/lib/jobs";
import { syncHolidays } from "@/lib/momentum/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Sundays: refresh the ticker list (names, types, active flags) and S&P 500 membership.
// ~13 Massive calls at 5/min ≈ 3 minutes, so it gets its own run.
export const GET = cronRoute("tickers", async () => ({ tickers: await syncTickers(), holidays: await syncHolidays() }));
