// Background jobs: each long task (convert, reference download, prepare, batch) runs as a separate
// `bt … --events` process, one at a time, so the app stays responsive and a crash can't take it down.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { BT_ROOT } from "../env.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Job = {
  id: number; kind: string; title: string; args: string[]; status: JobStatus;
  created: string; started: string | null; ended: string | null;
  progress: { done: number; total: number; label: string; run?: number; runs?: number } | null;
  log: string[]; result: { dir?: string } | null; error: string | null;
};
type Listener = (e: { job: Job; line?: string }) => void;

const CLI = join(BT_ROOT, "src", "cli.ts");

export class JobQueue {
  jobs: Job[] = [];
  private nextId = 1;
  private proc: ChildProcess | null = null;
  private listeners = new Set<Listener>();
  private onDone?: (job: Job) => void;

  constructor(onDone?: (job: Job) => void) {
    this.onDone = onDone;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(job: Job, line?: string) {
    for (const fn of this.listeners) fn({ job, line });
  }

  add(kind: string, title: string, args: string[]) {
    const job: Job = { id: this.nextId++, kind, title, args, status: "queued", created: new Date().toISOString(), started: null, ended: null, progress: null, log: [], result: null, error: null };
    this.jobs.unshift(job);
    if (this.jobs.length > 50) this.jobs = this.jobs.slice(0, 50);
    this.emit(job);
    this.pump();
    return job;
  }

  cancel(id: number) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.status === "queued") { job.status = "cancelled"; job.ended = new Date().toISOString(); this.emit(job); return true; }
    if (job.status === "running" && this.proc) { job.status = "cancelled"; this.proc.kill(); return true; }
    return false;
  }

  private line(job: Job, text: string) {
    job.log.push(text);
    if (job.log.length > 1000) job.log.splice(0, job.log.length - 1000);
    this.emit(job, text);
  }

  private pump() {
    if (this.proc) return;
    const job = [...this.jobs].reverse().find((j) => j.status === "queued");
    if (!job) return;
    job.status = "running";
    job.started = new Date().toISOString();
    this.emit(job);
    const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...job.args, "--events"], { cwd: BT_ROOT, env: process.env });
    this.proc = p;
    // A process that can't start (bad path, antivirus block…) fails the job instead of the app.
    p.on("error", (err) => {
      job.error = `Couldn't start the job: ${err.message}`;
      this.line(job, job.error);
    });
    let buf = "";
    p.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw) continue;
        let e: Record<string, unknown> | null = null;
        try { e = JSON.parse(raw); } catch { /* plain text */ }
        if (!e || typeof e.type !== "string") { this.line(job, raw); continue; }
        if (e.type === "progress") { job.progress = e as Job["progress"]; this.emit(job); }
        else if (e.type === "log") this.line(job, String(e.text));
        else if (e.type === "start") { job.result = { dir: String(e.dir) }; this.line(job, `Writing results to ${e.dir}`); }
        else if (e.type === "result") {
          const s = e.stats as { cagr: number; maxDrawdown: number; sharpe: number | null };
          this.line(job, `${e.label}: CAGR ${(s.cagr * 100).toFixed(1)}%, max drawdown ${(s.maxDrawdown * 100).toFixed(1)}%, Sharpe ${s.sharpe?.toFixed(2) ?? "—"}`);
        }
        else if (e.type === "done") job.result = { dir: String(e.dir) };
        else if (e.type === "error") { job.error = String(e.text).split("\n")[0]; this.line(job, String(e.text)); }
      }
    });
    p.stderr!.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) if (l.trim()) this.line(job, l);
    });
    p.on("close", (code) => {
      this.proc = null;
      if (job.status !== "cancelled") job.status = code === 0 ? "done" : "failed";
      if (job.status === "failed" && !job.error) job.error = job.log.at(-1) ?? `exit code ${code}`;
      job.ended = new Date().toISOString();
      this.emit(job);
      this.onDone?.(job);
      this.pump();
    });
  }
}
