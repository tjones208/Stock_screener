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

// ───────────── Pending deals ─────────────
// A deal opens on the first definitive-agreement / merger headline for its target and stays open
// (no entry, no hold) until a deal-closed or deal-terminated headline, or until it's cleared by hand.

export type DealEvent = { ticker: string; kind: "open" | "closed" | "terminated"; d: string; headline: string; url: string };

const DEAL_WORDS = String.raw`(?:acquisition|merger|takeover|buyout|sale|transaction|deal|combination|take-private|going-private|tender offer)`;
const TERMINATED = new RegExp(String.raw`\b(?:terminat\w*|call(?:s|ed)? off|abandon\w*|walk(?:s|ed)? away|scrap\w*|collaps\w*|blocks?|blocked|withdraw\w*)\b.{0,60}\b${DEAL_WORDS}|\b${DEAL_WORDS}\b.{0,40}\b(?:terminated|called off|abandoned|collapses|blocked|scrapped|falls through)\b`, "i");
const CLOSED = new RegExp(String.raw`\b(?:complet\w*|clos(?:es|ed|ing)|consummat\w*|finaliz\w*)\b.{0,60}\b${DEAL_WORDS}|\bhas been acquired by\b|\b(?:acquisition|merger) (?:is )?(?:now )?complete\b`, "i");

/**
 * Deal events for one article. Ended deals (closed / terminated) apply to every tagged ticker; an
 * opening needs an identified target: the buyout headline patterns, or a definitive / merger
 * agreement headline with a single tagged stock.
 */
export function dealEvents(a: Article, names: Map<string, string>): DealEvent[] {
  const tickers = a.tickers.filter((t) => names.has(t));
  if (!tickers.length) return [];
  const base = { d: a.published.slice(0, 10), headline: a.title.slice(0, 300), url: a.url };
  if (TERMINATED.test(a.title)) return tickers.map((ticker) => ({ ticker, kind: "terminated" as const, ...base }));
  if (CLOSED.test(a.title) && !TO_BE_ACQUIRED.test(a.title)) return tickers.map((ticker) => ({ ticker, kind: "closed" as const, ...base }));
  const hits = buyoutHits(a, names).filter((h) => h.kind === "buyout_news");
  if (hits.length) return hits.map((h) => ({ ticker: h.ticker, kind: "open" as const, ...base }));
  if (GENERIC.test(a.title) && tickers.length === 1) return [{ ticker: tickers[0], kind: "open", ...base }];
  return [];
}

export type PendingDeal = { ticker: string; opened_d: string; headline: string; status: "open" | "closed" | "terminated" | "cleared"; ended_d: string | null };

/**
 * Deal state from a ticker's events (any order): open from the first opening after the last
 * closed / terminated event; otherwise ended. A deal cleared by hand stays cleared until a newer
 * opening headline arrives.
 */
export function dealState(ticker: string, events: DealEvent[], prev?: { status: string; opened_d: string; cleared_at?: string | null } | null): PendingDeal | null {
  const mine = events.filter((e) => e.ticker === ticker).sort((x, y) => x.d.localeCompare(y.d));
  if (!mine.length) return null;
  const ends = mine.filter((e) => e.kind !== "open");
  const lastEnd = ends.at(-1) ?? null;
  const open = mine.find((e) => e.kind === "open" && (!lastEnd || e.d > lastEnd.d));
  if (open) {
    const cleared = prev?.status === "cleared" && prev.opened_d === open.d;
    return { ticker, opened_d: open.d, headline: open.headline, status: cleared ? "cleared" : "open", ended_d: null };
  }
  const firstOpen = mine.find((e) => e.kind === "open");
  if (!firstOpen || !lastEnd) return null; // only end headlines: no deal on record
  return { ticker, opened_d: firstOpen.d, headline: firstOpen.headline, status: lastEnd.kind as "closed" | "terminated", ended_d: lastEnd.d };
}
