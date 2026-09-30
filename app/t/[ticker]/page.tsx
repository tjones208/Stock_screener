import Link from "next/link";
import { notFound } from "next/navigation";
import { db, fetchAll } from "@/lib/db";
import { big, money, num, pct, signClass } from "@/lib/format";
import type { ScreenerRow } from "@/lib/screen";
import { addToWatchlist, removeFromWatchlist } from "@/app/actions";
import { PriceChart, type Bar } from "./chart";

export const dynamic = "force-dynamic";

function Stat({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${cls ?? ""}`}>{v}</div>
    </div>
  );
}

export default async function TickerPage({ params }: { params: Promise<{ ticker: string }> }) {
  const ticker = decodeURIComponent((await params).ticker).toUpperCase();
  const [{ data: row }, bars, { data: lists }, { data: memberships }] = await Promise.all([
    db().from("ss_screener").select("*").eq("ticker", ticker).maybeSingle<ScreenerRow>(),
    fetchAll<Bar>((a, b) => db().from("ss_daily_bars").select("d, o, h, l, c, v").eq("ticker", ticker).order("d").range(a, b)),
    db().from("ss_watchlists").select("id, name").order("sort_order"),
    db().from("ss_watchlist_items").select("watchlist_id").eq("ticker", ticker),
  ]);
  if (!row && !bars.length) notFound();

  const inLists = new Set((memberships ?? []).map((m) => m.watchlist_id));
  const r = row;

  return (
    <main>
      <div className="row spread">
        <div>
          <h1 style={{ marginBottom: 2 }}>{ticker} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>{r?.name}</span></h1>
          <div className="muted">{[r?.sector, r?.industry, r?.exchange].filter(Boolean).join(" · ")}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 22 }}>{money(r?.close)}</div>
          <div className={signClass(r?.change_pct)}>{pct(r?.change_pct, 2)} <span className="muted">EOD {r?.as_of}</span></div>
        </div>
      </div>

      <div style={{ margin: "12px 0" }}>
        <PriceChart bars={bars} />
      </div>

      <div className="row">
        {(lists ?? []).map((l) =>
          inLists.has(l.id) ? (
            <form key={l.id} action={removeFromWatchlist}>
              <input type="hidden" name="ticker" value={ticker} />
              <input type="hidden" name="watchlist_id" value={l.id} />
              <button className="ghost">★ {l.name} ✕</button>
            </form>
          ) : (
            <form key={l.id} action={addToWatchlist}>
              <input type="hidden" name="ticker" value={ticker} />
              <input type="hidden" name="watchlist_id" value={l.id} />
              <button className="ghost">☆ Add to {l.name}</button>
            </form>
          ),
        )}
        <a className="btn ghost" href={`https://robinhood.com/options/chains/${ticker}`} target="_blank" rel="noreferrer">Open chain in Robinhood ↗</a>
      </div>

      <h2>Technicals</h2>
      <div className="grid">
        <Stat k="RSI (14)" v={num(r?.rsi14, 1)} />
        <Stat k="SMA 20 / 50" v={`${num(r?.sma20)} / ${num(r?.sma50)}`} />
        <Stat k="SMA 200" v={num(r?.sma200)} />
        <Stat k="EMA 9 / 21" v={`${num(r?.ema9)} / ${num(r?.ema21)}`} />
        <Stat k="ATR (14)" v={num(r?.atr14)} />
        <Stat k="Hist. vol (30d)" v={pct(r?.hv30, 0, 100)} />
        <Stat k="52w range" v={`${num(r?.low_52w)} – ${num(r?.high_52w)}`} />
        <Stat k="From 52w high" v={pct(r?.pct_from_high)} cls={signClass(r?.pct_from_high)} />
        <Stat k="Gap at open" v={pct(r?.gap_pct)} cls={signClass(r?.gap_pct)} />
        <Stat k="Volume / 20d avg" v={`${big(r?.volume)} (${num(r?.vol_ratio, 1)}×)`} />
      </div>

      <h2>Fundamentals</h2>
      <div className="grid">
        <Stat k="Market cap" v={big(r?.market_cap)} />
        <Stat k="P/E" v={num(r?.pe, 1)} />
        <Stat k="P/S · P/B" v={`${num(r?.ps, 1)} · ${num(r?.pb, 1)}`} />
        <Stat k="EPS (TTM)" v={money(r?.eps_ttm)} />
        <Stat k="Revenue (TTM)" v={big(r?.revenue_ttm)} />
        <Stat k="Revenue growth YoY" v={pct(r?.revenue_growth_yoy)} cls={signClass(r?.revenue_growth_yoy)} />
        <Stat k="Gross / op. margin" v={`${pct(r?.gross_margin, 0)} / ${pct(r?.operating_margin, 0)}`} />
        <Stat k="Net margin" v={pct(r?.net_margin)} cls={signClass(r?.net_margin)} />
        <Stat k="ROE" v={pct(r?.roe)} />
        <Stat k="Debt / equity" v={num(r?.debt_to_equity)} />
        <Stat k="Current ratio" v={num(r?.current_ratio)} />
      </div>
      {r && r.pe == null && r.revenue_ttm == null && <p className="muted">Fundamentals are fetched a few tickers per minute; this one hasn&apos;t been reached yet.</p>}
      <p><Link href="/">← Back to screener</Link></p>
    </main>
  );
}
