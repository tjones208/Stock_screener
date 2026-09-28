"use client";
import { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function PushToggle() {
  const [state, setState] = useState<"loading" | "unsupported" | "needs-install" | "off" | "on" | "denied">("loading");

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        // iOS only exposes Web Push once the app is added to the Home Screen.
        const ios = /iPhone|iPad/.test(navigator.userAgent);
        setState(ios ? "needs-install" : "unsupported");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (Notification.permission === "denied") return setState("denied");
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) return alert("Push isn't configured yet (NEXT_PUBLIC_VAPID_PUBLIC_KEY missing).");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return setState("denied");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
    setState(res.ok ? "on" : "off");
  }

  const msg = {
    loading: "Checking notification support…",
    unsupported: "This browser doesn't support push notifications.",
    "needs-install": "On iPhone: tap Share → Add to Home Screen, open the app from there, then enable notifications here.",
    denied: "Notifications are blocked for this site — allow them in your browser/phone settings.",
    on: "Push notifications are on for this device.",
    off: "",
  }[state];

  return (
    <div className="panel row spread">
      <span>{state === "off" ? "Get nightly alerts as push notifications on this device." : msg}</span>
      {state === "off" && <button onClick={enable}>Enable notifications</button>}
    </div>
  );
}
