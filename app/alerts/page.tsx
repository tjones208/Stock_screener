import { db } from "@/lib/db";
import { ALERT_KINDS } from "@/lib/alerts";
import { createAlert, deleteAlert, toggleAlert } from "../actions";
import { PushToggle } from "./push";

export const dynamic = "force-dynamic";

export default async function Alerts() {
  const [{ data: rules }, { data: events }, { data: lists }, { data: screens }] = await Promise.all([
    db().from("ss_alert_rules").select("*").order("created_at", { ascending: false }),
    db().from("ss_alert_events").select("id, ticker, message, triggered_on, pushed_at").order("created_at", { ascending: false }).limit(100),
    db().from("ss_watchlists").select("id, name").order("name"),
    db().from("ss_screens").select("id, name").order("name"),
  ]);
  const scopeName = (r: { ticker: string | null; watchlist_id: number | null; screen_id: number | null }) => {
    if (r.ticker) return r.ticker;
    const parts = [
      r.watchlist_id ? `★ ${lists?.find((l) => l.id === r.watchlist_id)?.name}` : "",
      r.screen_id ? `▦ ${screens?.find((s) => s.id === r.screen_id)?.name}` : "",
    ].filter(Boolean);
    return parts.join(" ") || "All tickers";
  };

  return (
    <main>
      <h1>Alerts</h1>
      <PushToggle />

      <h2>New alert</h2>
      <form action={createAlert} className="panel filters">
        <label>
          Condition
          <select name="kind" required>
            {Object.entries(ALERT_KINDS).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
          </select>
        </label>
        <label>
          Value (price, RSI, ×, % …)
          <input name="value" inputMode="decimal" placeholder="e.g. 30" />
        </label>
        <label>
          Applies to
          <select name="scope" defaultValue="ticker">
            <option value="ticker">One ticker →</option>
            {(lists ?? []).map((l) => <option key={l.id} value={`w:${l.id}`}>Watchlist: {l.name}</option>)}
            {(screens ?? []).map((s) => <option key={s.id} value={`s:${s.id}`}>Screen: {s.name}</option>)}
            <option value="all">All tickers</option>
          </select>
        </label>
        <label>
          Ticker
          <input name="ticker" placeholder="e.g. F" autoCapitalize="characters" />
        </label>
        <label>
          Name (optional)
          <input name="name" />
        </label>
        <button type="submit" style={{ alignSelf: "flex-end" }}>Add alert</button>
      </form>
      <p className="muted">Alerts are checked once a night after the options scan (≈ 8–9pm ET). Each rule fires at most once per ticker per day.</p>

      <h2>Rules</h2>
      <div className="card-list">
        {(rules ?? []).map((r) => (
          <div key={r.id} className="panel row spread">
            <div>
              <b>{r.name}</b> <span className="pill">{scopeName(r)}</span>
              {!r.enabled && <span className="pill">paused</span>}
            </div>
            <div className="row">
              <form action={toggleAlert}>
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="enabled" value={r.enabled ? "0" : "1"} />
                <button className="ghost" type="submit">{r.enabled ? "Pause" : "Resume"}</button>
              </form>
              <form action={deleteAlert}>
                <input type="hidden" name="id" value={r.id} />
                <button className="danger" type="submit">Delete</button>
              </form>
            </div>
          </div>
        ))}
        {!rules?.length && <div className="muted">No alert rules yet.</div>}
      </div>

      <h2>Recent alerts</h2>
      <div className="card-list">
        {(events ?? []).map((e) => (
          <div key={e.id} className="panel">
            <div className="row spread"><a href={`/t/${e.ticker}`}><b>{e.ticker}</b></a><span className="muted">{e.triggered_on}</span></div>
            <div>{e.message}</div>
          </div>
        ))}
        {!events?.length && <div className="muted">Nothing yet.</div>}
      </div>
    </main>
  );
}
