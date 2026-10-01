import { cronRoute } from "@/lib/cron";
import { momentumUrgentPush } from "@/lib/momentum/notify";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Mon–Fri 14:30 and 15:30 UTC: whichever is 10:30 ET (EDT or EST) pushes the urgent sells still open.
export const GET = cronRoute("momentum-urgent", () => momentumUrgentPush());
