/** Broad sector from a 4-digit SIC code (used when no GICS sector is known). */
export function sectorFromSic(sic: string | null | undefined): string | null {
  if (!sic) return null;
  const n = Number(sic);
  if (!Number.isFinite(n)) return null;
  const between = (a: number, b: number) => n >= a && n <= b;
  if (n === 6798) return "Real Estate";
  // Health Care is checked first so it wins over the broader ranges below: drugs & biologics
  // (2830–2836), lab analytical instruments (3826, e.g. TXG, BRKR — not IT), medical devices
  // (3841–3851), medical & drug wholesale (5047, 5122), health services (80xx) and commercial
  // physical/biological research (8731, e.g. CROs like CRL).
  if (between(2830, 2836) || n === 3826 || between(3841, 3851) || n === 5047 || n === 5122 || between(8000, 8099) || n === 8731) {
    return "Health Care";
  }
  if (between(3570, 3579) || between(3670, 3679) || between(7370, 7379) || between(3660, 3669) || between(3820, 3829)) return "Information Technology";
  if (between(1300, 1399) || between(2900, 2999)) return "Energy";
  if (between(4900, 4999)) return "Utilities";
  if (between(4800, 4899) || between(2710, 2799) || between(7810, 7849)) return "Communication Services";
  if (between(6000, 6499) || between(6700, 6799)) return "Financials";
  if (between(6500, 6599)) return "Real Estate";
  if (between(1000, 1299) || between(1400, 1499) || between(2600, 2699) || between(2800, 2829) || between(2840, 2899) || between(3300, 3399)) return "Materials";
  if (between(2000, 2199) || between(5400, 5499) || between(2840, 2844)) return "Consumer Staples";
  if (between(5200, 5999) || between(7000, 7099) || between(3710, 3716) || between(2300, 2399) || between(3940, 3949) || between(5800, 5899)) return "Consumer Discretionary";
  if (between(1500, 1799) || between(3400, 3569) || between(3580, 3669) || between(3700, 3799) || between(4000, 4799) || between(8700, 8799)) return "Industrials";
  if (between(3600, 3699)) return "Information Technology";
  if (between(7000, 8999)) return "Industrials";
  // Industries the ranges above leave out (they only apply where nothing else matched).
  if (n === 3812 || n === 3990) return "Industrials"; // defense & navigation electronics, misc. manufacturing
  if (n === 3861 || n === 5045 || n === 5065) return "Information Technology"; // imaging equipment, computer & electronics distributors
  if (between(5171, 5172)) return "Energy"; // petroleum wholesale
  if (between(100, 999)) return "Consumer Staples"; // agriculture
  if (between(2200, 2299) || between(2500, 2599) || between(3100, 3199) || n === 3873 || between(3910, 3919)) {
    return "Consumer Discretionary"; // textiles, furniture, leather, watches, jewelry
  }
  if (between(2400, 2499) || between(3000, 3099) || between(3200, 3299)) return "Materials"; // lumber, rubber & plastics, stone/glass/concrete
  if (between(5000, 5099)) return "Industrials"; // durable-goods wholesale (trading companies & distributors)
  if (between(5100, 5199)) return "Consumer Staples"; // nondurable-goods wholesale (food & consumer distributors)
  return null;
}
