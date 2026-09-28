import { NextResponse } from "next/server";
import { COOKIE, checkPassword, makeSession, sessionKey } from "@/lib/auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const next = String(form.get("next") || "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const key = await sessionKey();
  if (!(await checkPassword(String(form.get("password") ?? ""), process.env.APP_PASSWORD)) || !key) {
    return NextResponse.redirect(new URL(`/login?error=1&next=${encodeURIComponent(safeNext)}`, req.url), 303);
  }
  const s = await makeSession(key);
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set(COOKIE, s.value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: s.maxAge });
  return res;
}
