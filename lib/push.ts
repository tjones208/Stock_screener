import "server-only";
import webpush from "web-push";
import { db } from "./db";
import { env, envOr } from "./env";

let configured = false;
function setup() {
  if (configured) return;
  webpush.setVapidDetails(
    envOr("VAPID_SUBJECT", "mailto:admin@example.com"),
    env("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
    env("VAPID_PRIVATE_KEY"),
  );
  configured = true;
}

/** Send one notification to every saved device. Drops subscriptions the browser has revoked. */
export async function pushAll(title: string, body: string, url = "/alerts"): Promise<number> {
  if (!process.env.VAPID_PRIVATE_KEY) return 0;
  setup();
  const { data: subs } = await db().from("ss_push_subscriptions").select("id, endpoint, p256dh, auth");
  let sent = 0;
  for (const s of subs ?? []) {
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
