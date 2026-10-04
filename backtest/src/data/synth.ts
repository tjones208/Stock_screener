// Synthetic market in Massive's flat-file layout, for tests and a quick demo without a subscription:
//   <out>/flat/YYYY/MM/YYYY-MM-DD.csv.gz  (ticker,volume,open,close,high,low,window_start,transactions)
//   <out>/ref/{tickers,splits,dividends,details}.jsonl
// Prices are UNADJUSTED like the real files: a 2-for-1 split halves the raw price on its date.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export type SynthOptions = { out: string; from?: string; years?: number; stocks?: number; seed?: number };

export function synth(o: SynthOptions) {
  const rand = rng(o.seed ?? 7);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const start = new Date((o.from ?? "2019-01-01") + "T00:00:00Z");
  const days: string[] = [];
  for (let d = new Date(start); days.length < 252 * (o.years ?? 4); d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) days.push(d.toISOString().slice(0, 10));
  }
  const sics = ["3674", "2834", "6022", "1311", "4911", "5812", "3711", "7372", "2911", "6798", "4813", "3841"];
  type Sym = { ticker: string; type: string; px: number; drift: number; vol: number; sic: string; endIdx: number; split?: string; div?: number };
  const syms: Sym[] = [
    { ticker: "SPY", type: "ETF", px: 250, drift: 0.08, vol: 0.16, sic: "", endIdx: days.length, div: 0.004 },
    { ticker: "MTUM", type: "ETF", px: 110, drift: 0.1, vol: 0.18, sic: "", endIdx: days.length, div: 0.003 },
  ];
  const n = o.stocks ?? 60;
  for (let k = 0; k < n; k++) {
    syms.push({
      ticker: `S${String(k).padStart(3, "0")}`, type: "CS", px: 20 + rand() * 180,
      drift: -0.1 + rand() * 0.5, vol: 0.2 + rand() * 0.4, sic: sics[k % sics.length],
      // One delisting two-thirds of the way through, one 2-for-1 split in the middle.
      endIdx: k === 1 ? Math.floor(days.length * 0.66) : days.length,
      split: k === 2 ? days[Math.floor(days.length / 2)] : undefined,
    });
  }
  const files = new Map<string, string[]>();
  const divs: { ticker: string; ex_dividend_date: string; cash_amount: number }[] = [];
  for (const s of syms) {
    let px = s.px, factor = 1; // factor: raw = adjusted × factor before the split
    if (s.split) factor = 2;
    for (let i = 0; i < s.endIdx; i++) {
      const d = days[i];
      if (s.split && d === s.split) factor = 1;
      const r = (s.drift - 0.5 * s.vol ** 2) / 252 + (s.vol / Math.sqrt(252)) * gauss();
      const open = px * (1 + 0.003 * gauss());
      px = px * Math.exp(r);
      const hi = Math.max(open, px) * (1 + Math.abs(0.006 * gauss())), lo = Math.min(open, px) * (1 - Math.abs(0.006 * gauss()));
      const vol = Math.round((2e5 + rand() * 3e6) / Math.max(px, 1) * 50);
      const row = [s.ticker, vol, (open * factor).toFixed(4), (px * factor).toFixed(4), (hi * factor).toFixed(4), (lo * factor).toFixed(4), Date.parse(d) * 1e6, 1000].join(",");
      if (!files.has(d)) files.set(d, []);
      files.get(d)!.push(row);
      if (s.div && i % 63 === 30) divs.push({ ticker: s.ticker, ex_dividend_date: d, cash_amount: +(px * s.div).toFixed(4) });
    }
  }
  for (const [d, rows] of files) {
    const dir = join(o.out, "flat", d.slice(0, 4), d.slice(5, 7));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${d}.csv.gz`), gzipSync("ticker,volume,open,close,high,low,window_start,transactions\n" + rows.join("\n") + "\n"));
  }
  const ref = join(o.out, "ref");
  mkdirSync(ref, { recursive: true });
  const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(ref, "tickers.jsonl"), jl(syms.map((s) => ({
    ticker: s.ticker, name: `${s.ticker} Inc`, type: s.type, primary_exchange: s.type === "ETF" ? "ARCX" : "XNYS",
    active: s.endIdx === days.length, delisted_utc: s.endIdx === days.length ? null : `${days[s.endIdx]}T00:00:00Z`,
  }))));
  writeFileSync(join(ref, "splits.jsonl"), jl(syms.filter((s) => s.split).map((s) => ({ ticker: s.ticker, execution_date: s.split, split_from: 1, split_to: 2 }))));
  writeFileSync(join(ref, "dividends.jsonl"), jl(divs));
  writeFileSync(join(ref, "details.jsonl"), jl(syms.filter((s) => s.sic).map((s) => ({ ticker: s.ticker, sic_code: s.sic }))));
  return { days: days.length, tickers: syms.length, split: syms.find((s) => s.split)!, delisted: syms[3].ticker };
}
