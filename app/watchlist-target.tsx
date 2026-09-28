"use client";
import { useRouter } from "next/navigation";
import { WL_COOKIE } from "@/lib/cookies";

/** Which watchlist the screener's ☆ buttons add to. Remembered in a cookie. */
export function WatchlistTarget({ lists, current }: { lists: { id: number; name: string }[]; current: number }) {
  const router = useRouter();
  return (
    <label className="row" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      ☆ adds to
      <select
        value={current}
        onChange={(e) => {
          document.cookie = `${WL_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
      >
        {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </label>
  );
}
