import "server-only";
import type { FinnhubEarning } from "./earnings";

// Finnhub free tier: 60 calls/minute. The key is sent as a header, never in the URL.
export const finnhubReady = () => !!process.env.FINNHUB_API_KEY;

export async function earningsCalendar(from: string, to: string): Promise<FinnhubEarning[]> {
  const url = new URL("https://finnhub.io/api/v1/calendar/earnings");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "X-Finnhub-Token": process.env.FINNHUB_API_KEY ?? "" }, cache: "no-store" });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Finnhub calendar/earnings → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { earningsCalendar?: FinnhubEarning[] };
    return body.earningsCalendar ?? [];
  }
  throw new Error("Finnhub calendar/earnings → rate limited");
}
