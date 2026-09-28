import "server-only";
import { NextResponse } from "next/server";
import { safeEqual } from "./auth";
import { logJob } from "./db";
import { cronToken } from "./secrets";

/** pg_cron (via pg_net) sends Authorization: Bearer <token from ss_app_secrets>. */
async function isCron(req: Request): Promise<boolean> {
  const token = await cronToken();
  return !!token && safeEqual(req.headers.get("authorization") ?? "", `Bearer ${token}`);
}

/** Wrap a job as a cron route: bearer-token check, job log row, JSON result. */
export function cronRoute(job: string, fn: (req: Request) => Promise<object>) {
  return async (req: Request) => {
    if (!(await isCron(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    try {
      return NextResponse.json(await logJob(job, () => fn(req)));
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  };
}
