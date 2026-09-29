import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | null = null;

/** Service-role client. Server-only: RLS has no policies, so this is the only way in. */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** PostgREST caps responses at 1000 rows; page through everything. */
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < pageSize) break;
  }
  return out;
}

/** Upsert in chunks so one request never gets too large. */
export async function upsertChunks(table: string, rows: object[], onConflict: string, chunk = 1000, ignoreDuplicates = false) {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await db().from(table).upsert(rows.slice(i, i + chunk), { onConflict, ignoreDuplicates });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export async function logJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const { data } = await db().from("ss_job_runs").insert({ job }).select("id").single();
  try {
    const result = await fn();
    if (data) {
      await db().from("ss_job_runs")
        .update({ status: "ok", finished_at: new Date().toISOString(), detail: result as object })
        .eq("id", data.id);
    }
    return result;
  } catch (e) {
    if (data) {
      await db().from("ss_job_runs")
        .update({ status: "error", finished_at: new Date().toISOString(), detail: { error: String(e) } })
        .eq("id", data.id);
    }
    throw e;
  }
}
