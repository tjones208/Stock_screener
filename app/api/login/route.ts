import { NextResponse } from "next/server";
import { COOKIE, checkPassword, makeSession } from "@/lib/auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const next = String(form.get("next") || "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (!(await checkPassword(String(form.get("password") ?? ""), process.env.APP_PASSWORD)) || !process.env.SESSION_SECRET) {
    return NextResponse.redirect(new URL(`/login?error=1&next=${encodeURIComponent(safeNext)}`, req.url), 303);
  }
  const s = await makeSession(process.env.SESSION_SECRET);
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set(COOKIE, s.value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: s.maxAge });
  return res;
}
