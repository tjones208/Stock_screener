// Rule check for positions you add by hand (pure, tested). Adding is always allowed; these are the
// warnings shown before you confirm and stored as the lot's rule-break note.
import { riskBudget, type MomConfig } from "./config.ts";

export type ManualCheck = {
  holding: boolean;          // adding shares to a stock you already hold
  inUniverse: boolean;
  entryOk: boolean;
  riskOn: boolean | null;
  rebalanceDay: boolean;     // today works a month-end signal (top-ups are allowed then)
  heldCount: number;         // distinct tickers held before this add
  N: number;
  I: number;
  sector: string;
  sectorNamesAfter: number;
  sectorDollarsAfter: number;
  shares: number;
  price: number;
  D: number;                 // stop distance for the new lot
  target: number | null;     // T for this ticker with it in the portfolio
  valueBefore: number;       // current value of the holding (0 for a new stock)
  washSaleSince?: string | null; // date it was last sold at a loss, within the wash-sale block
};

export function manualWarnings(c: ManualCheck, cfg: MomConfig): string[] {
  const w: string[] = [];
  const $ = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  if (c.riskOn !== true) w.push("The regime isn't risk-on, so the strategy is making no buys.");
  if (!c.holding) {
    if (!c.inUniverse) w.push("Not in the strategy's universe (fails the price, size, liquidity, history or data checks).");
    else if (!c.entryOk) w.push("Fails the entry test (momentum percentile, H52 or days since the high).");
    if (c.heldCount >= c.N) w.push(`No open slot: you already hold ${c.heldCount} of ${c.N} positions.`);
  } else if (!(c.rebalanceDay && c.entryOk && c.target != null && c.valueBefore < cfg.topup_below_mult * c.target)) {
    w.push(`Top-ups are only allowed at month-end, when the position is worth under ${cfg.topup_below_mult}× its target and still passes the entry test.`);
  }
  if (c.sectorNamesAfter > cfg.sector_max_names) w.push(`Sector ${c.sector} would hold ${c.sectorNamesAfter} names (limit ${cfg.sector_max_names}).`);
  if (c.sectorDollarsAfter > cfg.sector_max_pct_of_I * c.I + 1e-6) {
    w.push(`Sector ${c.sector} would be ${$(c.sectorDollarsAfter)}, over ${Math.round(cfg.sector_max_pct_of_I * 100)}% of investable (${$(cfg.sector_max_pct_of_I * c.I)}).`);
  }
  if (c.washSaleSince) {
    w.push(`Wash sale: sold at a loss on ${c.washSaleSince}; buying within ${cfg.wash_sale_block_days} days disallows that loss for taxes.`);
  }
  const risk = c.shares * c.D, cap = riskBudget(cfg);
  const basis = cfg.risk_basis === "E" ? `${(cfg.max_risk_pct_of_E * 100).toFixed(1)}% of equity` : `${(cfg.max_risk_pct_of_B * 100).toFixed(1)}% of buying power`;
  if (risk > cap + 1e-6) w.push(`Risk to the stop is ${$(risk)}, over the ${basis} limit (${$(cap)}).`);
  const after = c.valueBefore + c.shares * c.price;
  if (c.target != null && after > c.target + c.price) {
    w.push(`${c.holding ? "Takes the position" : "Position"} to ${$(after)}, over its target of ${$(c.target)}.`);
  }
  return w;
}
