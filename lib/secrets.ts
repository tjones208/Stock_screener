import "server-only";
import webpush from "web-push";
import { db } from "./db";

// App secrets live in public.ss_app_secrets (RLS on, no policies → service role only).
// The cron token is generated inside Postgres by migration 0003 and read by both pg_cron and
// this app, so it never has to be copied into Vercel. Env vars still override when set.

const cache = new Map<string, string>();

export async function appSecret(name: string): Promise<string | null> {
  if (cache.has(name)) return cache.get(name)!;
  const { data } = await db().from("ss_app_secrets").select("value").eq("name", name).maybeSingle();
  if (data?.value) cache.set(name, data.value);
  return data?.value ?? null;
}

export async function cronToken(): Promise<string | null> {
  return process.env.CRON_SECRET || appSecret("cron");
}

/** VAPID key pair for Web Push, created on first use and stored alongside the other secrets. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  let [pub, priv] = await Promise.all([appSecret("vapid_public"), appSecret("vapid_private")]);
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    // ignoreDuplicates: if two requests race, the first pair written wins and both re-read it.
    await db().from("ss_app_secrets").upsert(
      [{ name: "vapid_public", value: k.publicKey }, { name: "vapid_private", value: k.privateKey }],
      { onConflict: "name", ignoreDuplicates: true },
    );
    cache.delete("vapid_public");
    cache.delete("vapid_private");
    [pub, priv] = await Promise.all([appSecret("vapid_public"), appSecret("vapid_private")]);
  }
  if (!pub || !priv) throw new Error("Could not load or create VAPID keys");
  return { publicKey: pub, privateKey: priv };
}
