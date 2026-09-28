import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, sessionKey, verifySession } from "@/lib/auth";

const PUBLIC = [/^\/login$/, /^\/api\/login$/, /^\/api\/cron\//, /^\/manifest\.webmanifest$/, /^\/sw\.js$/, /^\/icon/, /^\/apple-icon/];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  if (await verifySession(await sessionKey(), req.cookies.get(COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
