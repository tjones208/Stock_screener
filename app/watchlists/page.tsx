import Link from "next/link";
import { db } from "@/lib/db";
import { big, num, pct, signClass } from "@/lib/format";
import type { ScreenerRow } from "@/lib/screen";
import { addToWatchlist, createWatchlist, deleteWatchlist, removeFromWatchlist } from "../actions";

export const dynamic = "force-dynamic";

export default async function Watchlists() {
  const [{ data: lists }, { data: items }] = await Promise.all([
    db().from("ss_watchlists").select("id, name").order("sort_order").order("name"),
    db().from("ss_watchlist_items").select("watchlist_id, ticker, added_at").order("ticker"),
  ]);
  const tickers = [...new Set((items ?? []).map((i) => i.ticker))];
  const { data: rows } = tickers.length
    ? await db().from("ss_screener").select("*").in("ticker", tickers)
    : { data: [] as ScreenerRow[] };
  const byTicker = new Map((rows ?? []).map((r: ScreenerRow) => [r.ticker, r]));

  return (
    <main>
      <h1>Watchlists</h1>
      <p className="muted">Watchlist tickers get their fundamentals fetched first and keep their full price history.</p>
      {(lists ?? []).map((l) => {
        const its = (items ?? []).filter((i) => i.watchlist_id === l.id);
        return (
          <section key={l.id} className="panel" style={{ marginBottom: 12 }}>
            <div className="row spread">
              <h2 style={{ margin: 0 }}>{l.name} <span className="pill">{its.length}</span></h2>
              <form action={deleteWatchlist}>
                <input type="hidden" name="id" value={l.id} />
                <button className="danger" type="submit">Delete list</button>
              </form>
            </div>
            <form action={addToWatchlist} className="row" style={{ margin: "10px 0" }}>
              <input type="hidden" name="watchlist_id" value={l.id} />
              <input name="ticker" placeholder="Add ticker, e.g. SOFI" autoCapitalize="characters" required />
              <button type="submit">Add</button>
            </form>
            {its.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Ticker</th><th>Price</th><th>Chg</th><th>RSI</th><th>RVOL</th><th>From 52w high</th><th>Mkt cap</th><th></th></tr></thead>
                  <tbody>
                    {its.map((i) => {
                      const r = byTicker.get(i.ticker);
                      return (
                        <tr key={i.ticker}>
                          <td><Link href={`/t/${i.ticker}`}><b>{i.ticker}</b></Link></td>
                          <td>{num(r?.close)}</td>
                          <td className={signClass(r?.change_pct)}>{pct(r?.change_pct)}</td>
                          <td>{num(r?.rsi14, 0)}</td>
                          <td>{num(r?.vol_ratio, 1)}×</td>
                          <td className={signClass(r?.pct_from_high)}>{pct(r?.pct_from_high, 0)}</td>
                          <td>{big(r?.market_cap)}</td>
                          <td>
                            <form action={removeFromWatchlist}>
                              <input type="hidden" name="watchlist_id" value={l.id} />
                              <input type="hidden" name="ticker" value={i.ticker} />
                              <button className="danger" type="submit" aria-label={`Remove ${i.ticker}`}>✕</button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      <form action={createWatchlist} className="row">
        <input name="name" placeholder="New watchlist name" required />
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
