import Link from "next/link";
import { db } from "@/lib/db";
import { big, money, num, pct } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Wheel({ searchParams }: { searchParams: Promise<{ maxDelta?: string; minYield?: string }> }) {
  const sp = await searchParams;
  const maxDelta = Number(sp.maxDelta || 0.35);
  const minYield = Number(sp.minYield || 0);
  const { data: latest } = await db().from("ss_option_candidates").select("as_of").order("as_of", { ascending: false }).limit(1);
  const asOf = latest?.[0]?.as_of;
  const { data: puts } = asOf
    ? await db().from("ss_option_candidates").select("*").eq("as_of", asOf)
        .gte("delta", -maxDelta).gte("annual_yield", minYield / 100)
        .order("score", { ascending: false }).limit(500)
    : { data: [] };

  // Best contract per ticker first, then the rest.
  const seen = new Set<string>();
  const best = (puts ?? []).filter((p) => (seen.has(p.ticker) ? false : (seen.add(p.ticker), true)));

  return (
    <main>
      <div className="row spread">
        <h1>Wheel candidates</h1>
        <span className="muted">{asOf ? `Scan ${asOf} · ${best.length} tickers` : "No options scan yet"}</span>
      </div>
      <form method="get" className="row panel" style={{ marginBottom: 12 }}>
        <label>Max delta<input name="maxDelta" inputMode="decimal" defaultValue={sp.maxDelta ?? "0.35"} style={{ width: 90 }} /></label>
        <label>Min yield %/yr<input name="minYield" inputMode="decimal" defaultValue={sp.minYield ?? ""} style={{ width: 90 }} /></label>
        <button type="submit" style={{ alignSelf: "flex-end" }}>Apply</button>
      </form>
      <p className="muted">Best cash-secured put per ticker, ranked by yield → IV → low delta → liquidity. Strike ≤ $50 so collateral fits $5,000.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Ticker</th><th>Price</th><th>Put</th><th>DTE</th><th>Mid</th><th>Yield/yr</th><th>Δ</th><th>IV</th><th>OI</th><th>Spread</th><th>OTM</th><th>Collateral</th><th>Score</th></tr>
          </thead>
          <tbody>
            {best.map((p) => (
              <tr key={p.contract}>
                <td><Link href={`/t/${p.ticker}`}><b>{p.ticker}</b></Link></td>
                <td>{num(p.underlying)}</td>
                <td>{num(p.strike, p.strike % 1 ? 1 : 0)}P {p.expiration.slice(5)}</td>
                <td>{p.dte}</td>
                <td>{num(p.mid)}</td>
                <td>{pct(p.annual_yield, 0, 100)}</td>
                <td>{p.delta == null ? "—" : num(Math.abs(p.delta))}</td>
                <td>{pct(p.iv, 0, 100)}</td>
                <td>{big(p.open_interest)}</td>
                <td>{pct(p.spread_pct, 0, 100)}</td>
                <td>{pct(p.otm_pct, 1, 100)}</td>
                <td>{money(p.collateral, 0)}</td>
                <td className="score">{num(p.score, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="notice">Indicative premiums (Alpaca free feed) — confirm in Robinhood before placing a trade.</div>
    </main>
  );
}
