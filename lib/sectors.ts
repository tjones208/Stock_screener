/** Broad sector from a 4-digit SIC code (used when no GICS sector is known). */
export function sectorFromSic(sic: string | null | undefined): string | null {
  if (!sic) return null;
  const n = Number(sic);
  if (!Number.isFinite(n)) return null;
  const between = (a: number, b: number) => n >= a && n <= b;
  if (n === 6798) return "Real Estate";
  if (between(2830, 2836) || between(3841, 3851) || between(8000, 8099)) return "Health Care";
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
  return null;
}
