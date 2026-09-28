import Link from "next/link";
import { db } from "@/lib/db";
import { loadScreener } from "@/lib/jobs";
import { applyFilters, BOOL_FILTERS, cleanFilters, DEFAULT_FILTERS, displayValue, GROUPS, NUMERIC_FIELDS, type Filters, type ScreenerRow } from "@/lib/screen";
import { STRATEGIES, STRATEGY_BY_KEY } from "@/lib/strategies";
import { LEVEL_RULES, levelsFor, type Levels } from "@/lib/levels";
import { sizePosition, type Size, type SizingSettings } from "@/lib/sizing";
import { getSizing } from "@/lib/settings";
import { big, money, num, pct, signClass } from "@/lib/format";
import { deleteScreen, saveScreen, saveSizing } from "./actions";
import { StrategyPicker } from "./strategy-picker";
import { WatchlistTarget } from "./watchlist-target";
import { WL_COOKIE } from "@/lib/cookies";
import { toggleWatchlist } from "./actions";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

type Col = { label: string; render: (r: ScreenerRow) => React.ReactNode; sort?: string };

const derived = (key: string) => {
  const f = NUMERIC_FIELDS.find((x) => x.key === key)!;
  return (r: ScreenerRow) => displayValue(f, r);
};
const atrPct = derived("atr_pct");
const dollarVol = derived("dollar_vol");
const fromVwap = derived("pct_from_vwap");
const fromSma20 = derived("pct_from_sma20");
const fromSma50 = derived("pct_from_sma50");
const signed = (v: number | null, d = 1) => <span className={signClass(v)}>{pct(v, d)}</span>;

/** Every column the table can show; strategies pick from these. */
const COLUMNS: Record<string, Col> = {
  close: { label: "Price", render: (r) => num(r.close) },
  change_pct: { label: "Chg", render: (r) => signed(r.change_pct) },
  gap_pct: { label: "Gap", render: (r) => signed(r.gap_pct) },
  change_5d: { label: "5d", render: (r) => signed(r.change_5d, 0) },
  change_20d: { label: "20d", render: (r) => signed(r.change_20d, 0) },
  rsi14: { label: "RSI", render: (r) => num(r.rsi14, 0) },
  vol_ratio: { label: "RVOL", render: (r) => num(r.vol_ratio, 1) },
  dollar_vol: { label: "$ Vol", render: (r) => big(dollarVol(r)) },
  atr_pct: { label: "ATR%", render: (r) => pct(atrPct(r)) },
  vwap: { label: "VWAP", render: (r) => num(r.vwap) },
  pct_from_vwap: { label: "vs VWAP", render: (r) => signed(fromVwap(r)) },
  pct_from_sma20: { label: "vs SMA20", render: (r) => signed(fromSma20(r)) },
  pct_from_sma50: { label: "vs SMA50", render: (r) => signed(fromSma50(r)) },
  range_pos: { label: "Close in range", render: (r) => (r.range_pos == null ? "—" : `${r.range_pos.toFixed(0)}%`) },
  nr7: { label: "NR7", render: (r) => (r.nr7 ? "✓" : "") },
  inside_day: { label: "Inside", render: (r) => (r.inside_day ? "✓" : "") },
  pct_from_high: { label: "52w hi", render: (r) => pct(r.pct_from_high, 0) },
  market_cap: { label: "Mkt cap", render: (r) => big(r.market_cap) },
  pe: { label: "P/E", render: (r) => num(r.pe, 1) },
  revenue_growth_yoy: { label: "Rev g", render: (r) => pct(r.revenue_growth_yoy, 0) },
  put: { label: "Put", sort: "put_strike", render: (r) => (r.put_strike ? `${num(r.put_strike, r.put_strike % 1 ? 1 : 0)}P ${r.put_expiration?.slice(5)}` : "—") },
  put_annual_yield: { label: "Yield/yr", render: (r) => pct(r.put_annual_yield, 0, 100) },
  put_delta: { label: "Δ", render: (r) => (r.put_delta == null ? "—" : num(Math.abs(r.put_delta), 2)) },
  put_iv: { label: "IV", render: (r) => pct(r.put_iv, 0, 100) },
  put_oi: { label: "OI", render: (r) => big(r.put_oi) },
  put_spread_pct: { label: "Spread", render: (r) => pct(r.put_spread_pct, 0, 100) },
  wheel_score: { label: "Score", render: (r) => <span className="score">{num(r.wheel_score, 0)}</span> },
};

const DEFAULT_COLUMNS = ["close", "change_pct", "rsi14", "vol_ratio", "pct_from_high", "market_cap", "pe", "revenue_growth_yoy", "put", "put_annual_yield", "put_delta", "put_iv", "put_oi", "wheel_score"];

function qs(f: Filters, patch: Filters = {}) {
  const p = new URLSearchParams({ ...f, ...patch });
  for (const [k, v] of [...p]) if (!v) p.delete(k);
  return `?${p}`;
}

export default async function Screener({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const filters = Object.keys(sp).length ? cleanFilters(sp) : DEFAULT_FILTERS;
  const [rows, { data: screens }, sizing, { data: lists }, { data: items }, jar] = await Promise.all([
    loadScreener(),
    db().from("ss_screens").select("id, name, filters").order("name"),
    getSizing(),
    db().from("ss_watchlists").select("id, name").order("sort_order").order("name"),
    db().from("ss_watchlist_items").select("watchlist_id, ticker"),
    cookies(),
  ]);
  const wantedList = Number(jar.get(WL_COOKIE)?.value);
  const targetList = lists?.find((l) => l.id === wantedList) ?? lists?.[0];
  const starred = new Set((items ?? []).filter((i) => i.watchlist_id === targetList?.id).map((i) => i.ticker));
  const results = applyFilters(rows, filters);
  const sectors = [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort() as string[];
  const asOf = rows.reduce((m, r) => (r.as_of > m ? r.as_of : m), "");
  const activeScreen = screens?.find((s) => qs(cleanFilters(s.filters)) === qs(filters));
  const strategy = filters.strategy ? STRATEGY_BY_KEY.get(filters.strategy) : undefined;
  const cols = (strategy?.columns ?? DEFAULT_COLUMNS).filter((k) => COLUMNS[k]).map((k) => ({ key: k, ...COLUMNS[k] }));
  const sortKey = filters.sort || "wheel_score";
  const levels = new Map<string, Levels | null>(strategy ? results.map((r) => [r.ticker, levelsFor(strategy.key, r)]) : []);
  const side = strategy && (filters.side === "long" || filters.side === "short") ? filters.side : "";
  const sided = side
    ? results.filter((r) => levels.get(r.ticker)?.side === (side === "long" ? "Long" : "Short"))
    : results;
  const shown = sided.slice(0, 300);
  const overnight = strategy?.style === "Swing";
  const sizes = new Map<string, Size | null>(
    shown.map((r) => {
      const l = levels.get(r.ticker);
      return [r.ticker, l ? sizePosition(l, r, overnight, sizing) : null];
    }),
  );
  const isWheel = strategy?.key === "wheel";
  const levelHeaders = isWheel
    ? ["Trade", "Credit", "Breakeven", "Buy back", "Contracts", "Collateral", "Profit @ target"]
    : ["Side", "Entry", "Stop", "Target", "R:R", "Risk/sh", "Shares", "Position", "$ Risk", "$ @ Target", "Sized by"];

  return (
    <main>
      <div className="row spread">
        <h1>Screener</h1>
        <span className="muted">{asOf ? `EOD ${asOf} · ${rows.length} tickers` : "No data yet — run the backfill"}</span>
      </div>

      {!!screens?.length && (
        <div className="row" style={{ marginBottom: 8 }}>
          {screens.map((s) => (
            <Link key={s.id} className={`btn ${activeScreen?.id === s.id ? "" : "ghost"}`} href={qs(cleanFilters(s.filters))}>
              {s.name}
            </Link>
          ))}
        </div>
      )}

      <div className="panel" style={{ marginBottom: 8 }}>
        <StrategyPicker
          current={strategy?.key ?? ""}
          options={STRATEGIES.map((s) => ({ key: s.key, name: s.name, style: s.style }))}
        />
        {strategy && (
          <div style={{ marginTop: 8 }}>
            <div>{strategy.summary}</div>
            <div className="muted" style={{ marginTop: 4 }}><b>Playbook:</b> {strategy.playbook}</div>
            {LEVEL_RULES[strategy.key] && (
              <div className="muted" style={{ marginTop: 4 }}><b>Entry/exit levels:</b> {LEVEL_RULES[strategy.key]}</div>
            )}
            {strategy.style === "Day trade" && (
              <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>Built from today&apos;s end-of-day data: this is tomorrow&apos;s watchlist. Entries and exits happen on a live intraday chart.</div>
            )}
            <SizingPanel s={sizing} overnight={overnight} wheel={isWheel} />
          </div>
        )}
      </div>

      <details className="panel" open={!rows.length ? false : undefined}>
        <summary>Filters ({Object.keys(filters).filter((k) => k !== "sort" && k !== "dir").length} active)</summary>
        <form method="get">
          <div className="filters">
            <label>
              Search
              <input name="q" defaultValue={filters.q} placeholder="Ticker or name" />
            </label>
            <label>
              Sector
              <select name="sector" defaultValue={filters.sector ?? ""}>
                <option value="">Any</option>
                {sectors.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            {strategy && (
              <label>
                Side (from the trade plan)
                <select name="side" defaultValue={filters.side ?? ""}>
                  <option value="">Long &amp; short</option>
                  <option value="long">Long only</option>
                  <option value="short">Short only</option>
                </select>
              </label>
            )}
            <label>
              Type
              <select name="type" defaultValue={filters.type ?? ""}>
                <option value="">Any</option>
                <option value="CS">Stocks</option>
                <option value="ETF">ETFs</option>
                <option value="ADRC">ADRs</option>
              </select>
            </label>
          </div>
          {GROUPS.map((g) => (
            <details key={g} open={g === "Price & volume"}>
              <summary>{g}</summary>
              <div className="filters">
                {NUMERIC_FIELDS.filter((f) => f.group === g).map((f) => (
                  <label key={f.key}>
                    {f.label} {f.unit && <span>({f.unit})</span>}
                    <span className="range">
                      <input name={`${f.key}_min`} inputMode="decimal" placeholder="min" defaultValue={filters[`${f.key}_min`]} />
                      <input name={`${f.key}_max`} inputMode="decimal" placeholder="max" defaultValue={filters[`${f.key}_max`]} />
                    </span>
                  </label>
                ))}
              </div>
            </details>
          ))}
          <details open>
            <summary>Conditions</summary>
            <div className="filters">
              {Object.entries(BOOL_FILTERS).map(([k, d]) => (
                <label key={k} className="check">
                  <input type="checkbox" name={k} value="1" defaultChecked={filters[k] === "1"} /> {d.label}
                </label>
              ))}
            </div>
          </details>
          <input type="hidden" name="strategy" value={filters.strategy ?? ""} />
          <input type="hidden" name="sort" value={filters.sort ?? ""} />
          <input type="hidden" name="dir" value={filters.dir ?? ""} />
          <div className="row" style={{ marginTop: 10 }}>
            <button type="submit">Apply</button>
            <Link className="btn ghost" href="/?close_max=">Clear</Link>
          </div>
        </form>
        <form action={saveScreen} className="row" style={{ marginTop: 12 }}>
          <input type="hidden" name="qs" value={qs(filters).slice(1)} />
          <input name="name" placeholder="Save as screen…" defaultValue={activeScreen?.name} />
          <button className="ghost" type="submit">Save</button>
        </form>
        {activeScreen && (
          <form action={deleteScreen} style={{ marginTop: 8 }}>
            <input type="hidden" name="id" value={activeScreen.id} />
            <button className="danger" type="submit">Delete “{activeScreen.name}”</button>
          </form>
        )}
      </details>

      <div className="row spread">
        <h2>{sided.length} matches{sided.length > 300 ? " (showing 300)" : ""}</h2>
        {targetList && <WatchlistTarget lists={lists ?? []} current={targetList.id} />}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th><Link href={qs(filters, { sort: "ticker", dir: filters.sort === "ticker" && filters.dir === "asc" ? "desc" : "asc" })}>Ticker</Link></th>
              {strategy && levelHeaders.map((h) => <th key={h} className="lvl">{h}</th>)}
              {cols.map((c) => {
                const key = c.sort ?? c.key;
                return (
                  <th key={c.key}>
                    <Link href={qs(filters, { sort: key, dir: sortKey === key && filters.dir !== "asc" ? "asc" : "desc" })}>
                      {c.label}{sortKey === key ? (filters.dir === "asc" ? " ▲" : " ▼") : ""}
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.ticker}>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    {targetList && (
                      <form action={toggleWatchlist}>
                        <input type="hidden" name="ticker" value={r.ticker} />
                        <input type="hidden" name="watchlist_id" value={targetList.id} />
                        <button
                          type="submit"
                          className="star"
                          aria-label={starred.has(r.ticker) ? `Remove ${r.ticker} from ${targetList.name}` : `Add ${r.ticker} to ${targetList.name}`}
                          title={starred.has(r.ticker) ? `On ${targetList.name}: tap to remove` : `Add to ${targetList.name}`}
                        >
                          {starred.has(r.ticker) ? "★" : "☆"}
                        </button>
                      </form>
                    )}
                    <Link href={`/t/${r.ticker}`}><b>{r.ticker}</b></Link>
                  </div>
                  <div className="muted" style={{ fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                </td>
                {strategy && <LevelCells l={levels.get(r.ticker) ?? null} size={sizes.get(r.ticker) ?? null} wheel={isWheel} />}
                {cols.map((c) => <td key={c.key}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

const usd0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

function LevelCells({ l, size, wheel }: { l: Levels | null; size: Size | null; wheel: boolean }) {
  const n = wheel ? 7 : 11;
  if (!l) return <>{Array.from({ length: n }, (_, i) => <td key={i} className="lvl muted">—</td>)}</>;
  const sizeCells = (count: number, cells: React.ReactNode[]) =>
    size ? cells : Array.from({ length: count }, (_, i) => <td key={`s${i}`} className="lvl muted">—</td>);
  if (wheel) {
    return (
      <>
        <td className="lvl" style={{ textAlign: "left" }}>{l.how}</td>
        <td className="lvl">{money(l.entry)}</td>
        <td className="lvl">{money(l.stop)}</td>
        <td className="lvl up">{money(l.target)}</td>
        {sizeCells(3, [
          <td key="q" className="lvl"><b>{size?.qty}</b></td>,
          <td key="p" className="lvl">{size && usd0(size.position)}</td>,
          <td key="w" className="lvl up">{size && usd0(size.reward)}</td>,
        ])}
      </>
    );
  }
  return (
    <>
      <td className={`lvl ${l.side === "Long" ? "up" : "down"}`} title={l.how}>{l.side}</td>
      <td className="lvl"><b>{money(l.entry)}</b></td>
      <td className="lvl down">{money(l.stop)}</td>
      <td className="lvl up">{money(l.target)}</td>
      <td className="lvl">{l.rr == null ? "—" : `${l.rr.toFixed(1)}R`}</td>
      <td className="lvl">{money(Math.abs(l.entry - l.stop))}</td>
      {sizeCells(5, [
        <td key="q" className="lvl"><b>{size?.qty.toLocaleString("en-US")}</b></td>,
        <td key="p" className="lvl">{size && usd0(size.position)}</td>,
        <td key="r" className="lvl down">{size && usd0(size.risk)}</td>,
        <td key="w" className="lvl up">{size && usd0(size.reward)}</td>,
        <td key="c" className="lvl"><span className="pill">{size?.cap}</span></td>,
      ])}
    </>
  );
}

function SizingPanel({ s, overnight, wheel }: { s: SizingSettings; overnight: boolean; wheel: boolean }) {
  const bp = s.account * (overnight ? s.overnightLeverage : s.dayTradeLeverage);
  const summary = wheel
    ? `${usd0(s.wheelAllocation)} of cash collateral per wheel position`
    : `Risk ${s.riskPct}% of ${usd0(s.account)} = ${usd0((s.account * s.riskPct) / 100)} per trade · ${overnight ? "overnight" : "day-trade"} buying power ${usd0(bp)} · max ${s.maxAdvPct}% of avg volume`;
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ fontWeight: 400 }}><b>Position sizing:</b> <span className="muted">{summary}</span></summary>
      <form action={saveSizing} className="filters">
        <label>Account size ($)<input name="account" inputMode="decimal" defaultValue={s.account} /></label>
        <label>Risk per trade (% of account)<input name="riskPct" inputMode="decimal" defaultValue={s.riskPct} /></label>
        <label>Day-trade buying power (× account)<input name="dayTradeLeverage" inputMode="decimal" defaultValue={s.dayTradeLeverage} /></label>
        <label>Overnight buying power (× account)<input name="overnightLeverage" inputMode="decimal" defaultValue={s.overnightLeverage} /></label>
        <label>Max % of avg daily volume<input name="maxAdvPct" inputMode="decimal" defaultValue={s.maxAdvPct} /></label>
        <label>Wheel $ per position<input name="wheelAllocation" inputMode="decimal" defaultValue={s.wheelAllocation} /></label>
        <button type="submit" style={{ alignSelf: "flex-end" }}>Save sizing</button>
      </form>
      <div className="muted" style={{ fontSize: 12 }}>
        Shares = the smallest of (dollar risk ÷ risk per share), (buying power ÷ entry) and ({s.maxAdvPct}% of average daily volume). The Sized by column shows which one applied.
        Commissions, slippage and short-borrow availability aren&apos;t included.
      </div>
    </details>
  );
}
