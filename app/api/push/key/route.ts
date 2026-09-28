import { NextResponse } from "next/server";
import { vapidKeys } from "@/lib/secrets";

export const dynamic = "force-dynamic";

// Public half of the VAPID pair (behind the login like every other page).
export async function GET() {
  return NextResponse.json({ publicKey: (await vapidKeys()).publicKey });
}
