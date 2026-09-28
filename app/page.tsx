import Link from "next/link";
import { db } from "@/lib/db";
import { loadScreener } from "@/lib/jobs";
import { applyFilters, BOOL_FILTERS, cleanFilters, DEFAULT_FILTERS, NUMERIC_FIELDS, type Filters, type ScreenerRow } from "@/lib/screen";
import { big, num, pct, signClass } from "@/lib/format";
import { deleteScreen, saveScreen } from "./actions";

export const dynamic = "force-dynamic";

type Col = { key: keyof ScreenerRow; label: string; render: (r: ScreenerRow) => React.ReactNode };

const COLS: Col[] = [
  { key: "close", label: "Price", render: (r) => num(r.close) },
  { key: "change_pct", label: "Chg", render: (r) => <span className={signClass(r.change_pct)}>{pct(r.change_pct)}</span> },
  { key: "rsi14", label: "RSI", render: (r) => num(r.rsi14, 0) },
  { key: "vol_ratio", label: "Vol×", render: (r) => num(r.vol_ratio, 1) },
  { key: "pct_from_high", label: "52w hi", render: (r) => pct(r.pct_from_high, 0) },
  { key: "market_cap", label: "Mkt cap", render: (r) => big(r.market_cap) },
  { key: "pe", label: "P/E", render: (r) => num(r.pe, 1) },
  { key: "revenue_growth_yoy", label: "Rev g", render: (r) => pct(r.revenue_growth_yoy, 0) },
  { key: "put_strike", label: "Put", render: (r) => (r.put_strike ? `${num(r.put_strike, r.put_strike % 1 ? 1 : 0)}P ${r.put_expiration?.slice(5)}` : "—") },
  { key: "put_annual_yield", label: "Yield/yr", render: (r) => pct(r.put_annual_yield, 0, 100) },
  { key: "put_delta", label: "Δ", render: (r) => (r.put_delta == null ? "—" : num(Math.abs(r.put_delta), 2)) },
  { key: "put_iv", label: "IV", render: (r) => pct(r.put_iv, 0, 100) },
  { key: "put_oi", label: "OI", render: (r) => big(r.put_oi) },
  { key: "wheel_score", label: "Score", render: (r) => <span className="score">{num(r.wheel_score, 0)}</span> },
];

const GROUPS = ["Price & volume", "Technical", "Fundamental", "Wheel"] as const;

function qs(f: Filters, patch: Filters = {}) {
  const p = new URLSearchParams({ ...f, ...patch });
  for (const [k, v] of [...p]) if (!v) p.delete(k);
  return `?${p}`;
}

export default async function Screener({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const filters = Object.keys(sp).length ? cleanFilters(sp) : DEFAULT_FILTERS;
  const [rows, { data: screens }] = await Promise.all([loadScreener(), db().from("ss_screens").select("id, name, filters").order("name")]);
  const results = applyFilters(rows, filters);
  const sectors = [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort() as string[];
  const asOf = rows.reduce((m, r) => (r.as_of > m ? r.as_of : m), "");
  const activeScreen = screens?.find((s) => qs(cleanFilters(s.filters)) === qs(filters));

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

      <h2>{results.length} matches{results.length > 300 ? " (showing 300)" : ""}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th><Link href={qs(filters, { sort: "ticker", dir: filters.sort === "ticker" && filters.dir === "asc" ? "desc" : "asc" })}>Ticker</Link></th>
              {COLS.map((c) => (
                <th key={c.key}>
                  <Link href={qs(filters, { sort: c.key, dir: filters.sort === c.key && filters.dir !== "asc" ? "asc" : "desc" })}>
                    {c.label}{(filters.sort || "wheel_score") === c.key ? (filters.dir === "asc" ? " ▲" : " ▼") : ""}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.slice(0, 300).map((r) => (
              <tr key={r.ticker}>
                <td>
                  <Link href={`/t/${r.ticker}`}><b>{r.ticker}</b></Link>
                  <div className="muted" style={{ fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                </td>
                {COLS.map((c) => <td key={c.key}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
