// Download Massive reference data the backtest needs (run on your own machine with MASSIVE_API_KEY):
//   tickers.jsonl    every stock ticker, active and delisted (type, exchange, delisting date)
//   splits.jsonl     all splits (for split-adjusting the unadjusted flat files)
//   dividends.jsonl  all cash dividends (paid into the backtest portfolio on ex-dates)
//   details.jsonl    optional: SIC codes per ticker (sector caps), one call per ticker
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FetchOptions = { out: string; details?: boolean; types?: string[]; rps?: number; base?: string; log?: (s: string) => void };

export async function fetchReference(o: FetchOptions) {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new Error("Set MASSIVE_API_KEY in the environment (never paste it into code or chat).");
  const base = o.base ?? process.env.MASSIVE_BASE_URL ?? "https://api.massive.com";
  const gap = 1000 / (o.rps ?? 10);
  const log = o.log ?? console.log;
  mkdirSync(o.out, { recursive: true });
  let lastCall = 0;
  async function get(pathOrUrl: string, params: Record<string, string | number> = {}): Promise<{ results?: unknown; next_url?: string; status?: string }> {
    const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("apiKey", key!);
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = lastCall + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
      if (res.status === 404) return {};
      if (!res.ok) throw new Error(`${url.pathname} → ${res.status} ${(await res.text()).slice(0, 300)} [sunset: ${res.headers.get("sunset") ?? "-"}; link: ${res.headers.get("link") ?? "-"}]`);
      return (await res.json()) as { results?: unknown; next_url?: string };
    }
    throw new Error(`${url.pathname}: too many retries`);
  }
  async function paged(file: string, path: string, params: Record<string, string | number>) {
    let next: string | undefined = path, p = params, rows = 0;
    while (next) {
      const r = await get(next, p);
      const list = (Array.isArray(r.results) ? r.results : []) as object[];
      if (list.length) appendFileSync(join(o.out, file), list.map((x) => JSON.stringify(x)).join("\n") + "\n");
      rows += list.length;
      next = r.next_url;
      p = {};
      if (rows % 10000 < list.length) log(`  ${file}: ${rows.toLocaleString()}`);
    }
    return rows;
  }
  for (const f of ["tickers.jsonl", "splits.jsonl", "dividends.jsonl"]) writeFileSync(join(o.out, f), "");
  log("Tickers (active and delisted)…");
  const t1 = await paged("tickers.jsonl", "/v3/reference/tickers", { market: "stocks", active: "true", limit: 1000 });
  const t2 = await paged("tickers.jsonl", "/v3/reference/tickers", { market: "stocks", active: "false", limit: 1000 });
  log(`  ${t1 + t2} tickers`);
  log("Splits…");
  log(`  ${await paged("splits.jsonl", "/v3/reference/splits", { limit: 1000, order: "asc", sort: "execution_date" })} splits`);
  log("Dividends…");
  log(`  ${await paged("dividends.jsonl", "/v3/reference/dividends", { limit: 1000, order: "asc", sort: "ex_dividend_date" })} dividends`);

  if (o.details) {
    const types = new Set(o.types ?? ["CS"]);
    const all = readFileSync(join(o.out, "tickers.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { ticker: string; type?: string; active?: boolean; delisted_utc?: string });
    const file = join(o.out, "details.jsonl");
    const done = new Set(existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { ticker: string }).ticker) : []);
    const todo = [...new Map(all.filter((t) => types.has(t.type ?? "")).map((t) => [t.ticker, t])).values()].filter((t) => !done.has(t.ticker));
    log(`Ticker details (SIC codes): ${todo.length} to fetch (resumable)…`);
    let k = 0;
    for (const t of todo) {
      // Delisted tickers need a date when they still existed.
      const date = !t.active && t.delisted_utc ? new Date(Date.parse(t.delisted_utc) - 7 * 86_400_000).toISOString().slice(0, 10) : undefined;
      const r = await get(`/v3/reference/tickers/${encodeURIComponent(t.ticker)}`, date ? { date } : {});
      const d = r.results as { ticker?: string; sic_code?: string; sic_description?: string; market_cap?: number } | undefined;
      appendFileSync(file, JSON.stringify({ ticker: t.ticker, sic_code: d?.sic_code ?? null, sic_description: d?.sic_description ?? null }) + "\n");
      if (++k % 500 === 0) log(`  ${k} / ${todo.length}`);
    }
  }
  log(`Done: ${o.out}`);
}
