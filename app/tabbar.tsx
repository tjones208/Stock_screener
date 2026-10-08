"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Screener", ico: "▦" },
  { href: "/momentum", label: "Momentum", ico: "↗" },
  { href: "/pullback", label: "Pullback", ico: "↻" },
  { href: "/watchlists", label: "Watchlists", ico: "★" },
  { href: "/alerts", label: "Alerts", ico: "🔔" },
];

export function TabBar() {
  const path = usePathname();
  if (path === "/login") return null;
  return (
    <nav className="tabbar">
      {TABS.map((t) => {
        const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : ""}>
            <span className="ico">{t.ico}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
