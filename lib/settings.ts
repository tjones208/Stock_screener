import "server-only";
import { db } from "./db";
import { normalizeSizing, type SizingSettings } from "./sizing";

export async function getSizing(): Promise<SizingSettings> {
  const { data } = await db().from("ss_settings").select("value").eq("key", "sizing").maybeSingle();
  return normalizeSizing(data?.value as Record<string, unknown> | undefined);
}

export async function setSizing(s: SizingSettings) {
  const { error } = await db().from("ss_settings").upsert({ key: "sizing", value: s, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
