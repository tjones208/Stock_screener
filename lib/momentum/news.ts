// Pending-buyout detection from news headlines (spec 3.6a). Matching is on the headline only.
// The acquirer is usually tagged on the same article, so the target is identified from the headline:
//   "<Target> ... to be acquired by ..." / "<Target> enters definitive agreement to be acquired"
//   "<Acquirer> to acquire <Target> for $X per share"
// When the target can't be pinned to one tagged ticker, every tagged ticker gets a review flag instead.

export type Article = { title: string; tickers: string[]; published: string; url: string };
export type BuyoutHit = { ticker: string; kind: "buyout_news" | "buyout_review"; d: string; detail: string };

// Covers "definitive agreement to be acquired", "agrees to be acquired", "to be acquired by".
const TO_BE_ACQUIRED = /\b(?:to be acquired|to be taken private)\b/i;
const ACQUIRE_FOR = /\b(?:to )?acquires?\b\s+(.+?)\s+for\s+\$\s?[\d.,]+\s*(?:per|a)\s+share/i;
const GENERIC = /\b(?:definitive agreement|merger agreement)\b/i;

const STOP = new Set(["inc", "corp", "corporation", "co", "company", "ltd", "plc", "holdings", "group", "the", "class", "common", "stock", "shares", "sa", "nv", "ag", "lp", "llc", "limited", "incorporated", "trust"]);

/** Distinctive lowercase words of a company name ("Acme Widgets Inc." → ["acme", "widgets"]). */
export function nameKeys(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}

function mentions(text: string, name: string | undefined, ticker: string): boolean {
  const t = text.toLowerCase();
  if (new RegExp(`\\b${ticker.toLowerCase()}\\b`).test(t) && ticker.length >= 3) return true;
  const keys = name ? nameKeys(name) : [];
  return keys.length > 0 && t.includes(keys[0]);
}

/**
 * Buyout hits for one article. `names` maps tagged tickers to company names (common stocks only;
 * tickers missing from it are ignored).
 */
export function buyoutHits(a: Article, names: Map<string, string>): BuyoutHit[] {
  const tickers = a.tickers.filter((t) => names.has(t));
  if (!tickers.length) return [];
  const d = a.published.slice(0, 10);
  const detail = a.title.slice(0, 300);

  let segment: string | null = null;
  const tba = a.title.match(TO_BE_ACQUIRED);
  if (tba) segment = a.title.slice(0, tba.index); // target named before the phrase
  const af = !segment ? a.title.match(ACQUIRE_FOR) : null;
  if (af) segment = af[1]; // target named between "acquire" and "for $X per share"

  if (segment !== null) {
    if (tickers.length === 1) return [{ ticker: tickers[0], kind: "buyout_news", d, detail }];
    const targets = tickers.filter((t) => mentions(segment!, names.get(t), t));
    if (targets.length === 1) return [{ ticker: targets[0], kind: "buyout_news", d, detail }];
    return tickers.map((ticker) => ({ ticker, kind: "buyout_review" as const, d, detail }));
  }
  if (GENERIC.test(a.title)) return tickers.map((ticker) => ({ ticker, kind: "buyout_review" as const, d, detail }));
  return [];
}
