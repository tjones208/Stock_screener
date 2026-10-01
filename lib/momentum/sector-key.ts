// Sector bucket for the momentum sector caps: one of the 11 GICS sectors, so one theme can't be
// spread across several SIC buckets (e.g. genomics names under SIC 28, 38 and 80 are all Health Care).
import { sectorFromSic } from "../sectors.ts";

export const GICS_SECTORS = [
  "Communication Services", "Consumer Discretionary", "Consumer Staples", "Energy", "Financials",
  "Health Care", "Industrials", "Information Technology", "Materials", "Real Estate", "Utilities",
] as const;

export type SectorInfo = {
  ticker: string;
  in_sp500?: boolean | null;
  /** ss_tickers.sector: real GICS for S&P 500 names; for others it may be a stale SIC mapping. */
  sector?: string | null;
  /** 4-digit SIC code (ss_tickers.sic_code). */
  sic_code?: string | null;
  sic2?: string | null;
};

const UNKNOWN = "unknown";
const isGics = (s: string | null | undefined): s is string => !!s && (GICS_SECTORS as readonly string[]).includes(s);

/**
 * GICS sector for a ticker, in this order:
 *   a) ss_tickers.sector when the ticker is in the S&P 500 (real GICS);
 *   b) the 4-digit SIC code (sectorFromSic);
 *   c) the 2-digit SIC major group;
 *   d) "unknown:TICKER" — each unknown name is its own bucket, so missing data neither blocks
 *      buys nor lets unrelated names share a cap.
 */
export function momSector(t: SectorInfo): string {
  if (t.in_sp500 && isGics(t.sector)) return t.sector;
  const fromSic = sectorFromSic(t.sic_code);
  if (fromSic) return fromSic;
  const sic2 = t.sic2 ?? (t.sic_code ? t.sic_code.slice(0, 2) : null);
  if (sic2 && /^\d{2}$/.test(sic2)) {
    // Major group only: try the start and the end of the group's range.
    const g = sectorFromSic(`${sic2}00`) ?? sectorFromSic(`${sic2}99`);
    if (g) return g;
  }
  return `${UNKNOWN}:${t.ticker}`;
}

/** Display name for a sector key ("unknown:XYZ" → "Unknown"). */
export const sectorLabel = (key: string | null | undefined) => (!key || key.startsWith(`${UNKNOWN}:`) || key === UNKNOWN ? "Unknown" : key);
