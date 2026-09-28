export function num(v: number | null | undefined, d = 2): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function pct(v: number | null | undefined, d = 1, scale = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * scale).toFixed(d)}%`;
}
export function money(v: number | null | undefined, d = 2): string {
  return v == null ? "—" : `$${num(v, d)}`;
}
export function big(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
}
export function signClass(v: number | null | undefined): string {
  return v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "";
}
