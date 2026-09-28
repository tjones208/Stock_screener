import "server-only";
import webpush from "web-push";
import { db } from "./db";
import { vapidKeys } from "./secrets";

function subject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL; // set automatically by Vercel
  return host ? `https://${host}` : "mailto:admin@localhost";
}

/** Send one notification to every saved device. Drops subscriptions the browser has revoked. */
export async function pushAll(title: string, body: string, url = "/alerts"): Promise<number> {
  const { data: subs } = await db().from("ss_push_subscriptions").select("id, endpoint, p256dh, auth");
  if (!subs?.length) return 0;
  const k = await vapidKeys();
  webpush.setVapidDetails(subject(), k.publicKey, k.privateKey);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url }),
      );
      sent++;
      await db().from("ss_push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db().from("ss_push_subscriptions").delete().eq("id", s.id);
    }
  }
  return sent;
}
