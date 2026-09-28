import "server-only";
import { NextResponse } from "next/server";
import { isCron } from "./auth";
import { logJob } from "./db";

/** Wrap a job as a cron route: bearer-token check, job log row, JSON result. */
export function cronRoute(job: string, fn: (req: Request) => Promise<object>) {
  return async (req: Request) => {
    if (!isCron(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    try {
      return NextResponse.json(await logJob(job, () => fn(req)));
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  };
}
