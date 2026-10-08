import Link from "next/link";
import { db } from "@/lib/db";
import { nyToday } from "@/lib/dates";
import { money, num, pct, signClass } from "@/lib/format";
import { PB_FIELDS } from "@/lib/pullback/core";
import { EXIT_LABEL, getPb, loadTrades, openTradeStatus, pbEquity, tradePnl, type BuyRow, type ExitStatus } from "@/lib/pullback/scan";
import { editLevels, logBuy, logSell, runScanNow, saveAccountValue, savePbSettings, undoTrade } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Scan = {
  signal_d: string; trade_d: string | null; equity: number | null; created_at: string;
  regime: { ticker: string; close: number; ma: number | null; ok: boolean; filter: boolean } | null;
  funnel: { step: string; count: number }[] | null; buys: BuyRow[]; warnings: string[];
};

export default async function Pullback() {
  const [s, trades, { data: scanRow }] = await Promise.all([
    getPb(), loadTrades(),
    db().from("ss_pb_scans").select("signal_d, trade_d, equity, created_at, regime, funnel, buys, warnings").order("signal_d", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const p = s.params;
  const scan = scanRow as Scan | null;
  const open = trades.filter((t) => !t.exit_d);
  const closed = trades.filter((t) => t.exit_d).sort((a, b) => (b.exit_d! < a.exit_d! ? -1 : 1));
  const status = await openTradeStatus(trades, p);
  const byId = new Map(status.map((x) => [x.id, x]));
  const equity = pbEquity(s, trades);
  const heat = open.reduce((a, t) => a + t.shares * Math.max(0, t.entry - t.stop), 0);
  const held = new Set(open.map((t) => t.ticker));
  const buys = (scan?.buys ?? []).filter((b) => !held.has(b.ticker));
  const actionable = buys.filter((b) => b.shares && !b.skip);
  const skipped = buys.filter((b) => !b.shares || b.skip);
  const exits = open.filter((t) => byId.get(t.id)?.action === "EXIT");
  const realized = closed.reduce((a, t) => a + tradePnl(t), 0);
  const rOf = (t: { entry: number; stop: number; exit: number | null }) => (t.exit == null || t.entry <= t.stop ? null : (t.exit - t.entry) / (t.entry - t.stop));
  const wins = closed.filter((t) => tradePnl(t) > 0).length;
  const today = nyToday();
  const tradeDay = scan?.trade_d ?? today;

  return (
    <main>
      <div className="row spread">
        <h1>Pullback</h1>
        <span className="muted">{scan ? `Signals ${scan.signal_d} · for ${tradeDay}` : "No scan yet"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Momentum pullback swing: buy a strong uptrend after a pullback once it closes above the prior high; swing-low stop,{" "}
        {p.reward_risk}R target, exit on a close under the {p.fast_ma}-day average or after {p.max_hold_days} sessions.
      </p>

      <nav className="mnav">
        <a href="#exit"><span className="tag tag-sell">SELL</span> {exits.length}</a>
        <a href="#buy"><span className="tag tag-buy">BUY</span> {actionable.length}</a>
        <a href="#hold"><span className="tag tag-hold">HOLD</span> {open.length}</a>
        <a href="#info"><span className="tag tag-info">INFO</span></a>
      </nav>

      {(scan?.warnings ?? []).map((w, i) => <p key={i} className="panel" style={{ color: "var(--warn)" }}>⚠ {w}</p>)}
      {s.account_value == null && (
        <p className="panel" style={{ color: "var(--warn)" }}>⚠ Set your account value under Account to get share counts.</p>
      )}

      <section id="exit" className="panel" style={{ marginTop: 12 }}>
        <div className="row spread"><h2 style={{ margin: 0 }}><span className="tag tag-sell">SELL</span> Exits</h2>
          <span className="muted">{exits.length ? "Sell these at the open" : "Nothing to sell"}</span></div>
        {exits.map((t) => <TradeCard key={t.id} t={t} st={byId.get(t.id)!} today={today} />)}
      </section>

      <section id="buy" className="panel" style={{ marginTop: 12 }}>
        <div className="row spread">
          <h2 style={{ margin: 0 }}><span className="tag tag-buy">BUY</span> Buys for {tradeDay}</h2>
          <form action={runScanNow}><button type="submit" className="ghost">Run scan now</button></form>
        </div>
        <p className="muted">
          Buy at the open, only if it opens inside the range (keeps the stop {pct(p.min_stop_pct, 0, 100)}–{pct(p.max_stop_pct, 0, 100)} away).
          Shares are sized off the close; after the fill, place a stop order at the stop and a limit sell at the target (Robinhood can't link them: cancel one when the other fills).
        </p>
        {!scan && <p className="muted">No scan yet: it runs each weekday morning, or tap Run scan now.</p>}
        {scan && !actionable.length && <p className="muted">No buys.</p>}
        <div className="card-list">
          {actionable.map((b) => (
            <div key={b.ticker} className="panel">
              <div className="row">
                <span className="tag tag-buy">BUY</span>
                <Link href={`/t/${b.ticker}`}><b>{b.ticker}</b></Link>
                <span>{b.shares} sh ≈ {money(b.value, 0)}</span>
                <span className="muted">close {num(b.close)} · stop {num(b.stop)} ({pct(b.stop_pct, 1, 100)}) · target {num(b.target)} · risk {money(b.risk, 0)} · RS {pct(b.rs, 0, 100)}</span>
              </div>
              <div className="muted">Open between <b>{num(b.entry_min)}</b> and <b>{num(b.entry_max)}</b>; outside that, skip it.</div>
              <form action={logBuy} className="row" style={{ marginTop: 6 }}>
                <input type="hidden" name="ticker" value={b.ticker} />
                <input type="hidden" name="signal_d" value={scan!.signal_d} />
                <input type="hidden" name="stop" value={b.stop} />
                <label>Fill price<input name="entry" inputMode="decimal" style={{ width: 90 }} required /></label>
                <label>Shares<input name="shares" inputMode="decimal" defaultValue={b.shares ?? ""} style={{ width: 80 }} required /></label>
                <label>Date<input type="date" name="entry_d" defaultValue={tradeDay <= today ? tradeDay : today} /></label>
                <button type="submit" style={{ alignSelf: "flex-end" }}>Bought</button>
              </form>
            </div>
          ))}
        </div>
        {skipped.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary className="muted">{skipped.length} signal{skipped.length > 1 ? "s" : ""} not sized</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Ticker</th><th>Why</th><th>Close</th><th>Stop</th><th>Stop %</th><th>RS</th></tr></thead>
                <tbody>{skipped.map((b) => (
                  <tr key={b.ticker}><td><Link href={`/t/${b.ticker}`}>{b.ticker}</Link></td><td style={{ textAlign: "left" }}>{b.skip ?? "No account value"}</td>
                    <td>{num(b.close)}</td><td>{num(b.stop)}</td><td>{pct(b.stop_pct, 1, 100)}</td><td>{pct(b.rs, 0, 100)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        )}
      </section>

      <section id="hold" className="panel" style={{ marginTop: 12 }}>
        <div className="row spread"><h2 style={{ margin: 0 }}><span className="tag tag-hold">HOLD</span> Open trades</h2>
          <span className="muted">{open.length} of {p.max_positions} · open risk {money(heat, 0)}{equity ? ` (${pct(heat / equity, 2, 100)} of ${pct(p.max_portfolio_heat, 1, 100)} cap)` : ""}</span></div>
        {open.filter((t) => byId.get(t.id)?.action !== "EXIT").map((t) => <TradeCard key={t.id} t={t} st={byId.get(t.id)!} today={today} />)}
        {!open.length && <p className="muted">No open trades. Log a buy from the list above, or add one below.</p>}
        <details style={{ marginTop: 8 }}>
          <summary>Add a trade by hand</summary>
          <form action={logBuy} className="filters">
            <label>Ticker<input name="ticker" required /></label>
            <label>Fill price<input name="entry" inputMode="decimal" required /></label>
            <label>Shares<input name="shares" inputMode="decimal" required /></label>
            <label>Stop<input name="stop" inputMode="decimal" required /></label>
            <label>Target (blank = {p.reward_risk}R)<input name="target" inputMode="decimal" /></label>
            <label>Date<input type="date" name="entry_d" defaultValue={today} /></label>
            <button type="submit" style={{ alignSelf: "flex-end" }}>Add trade</button>
          </form>
        </details>
      </section>

      <section id="info" className="panel" style={{ marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}><span className="tag tag-info">INFO</span> Account and history</h2>
        <form action={saveAccountValue} className="row">
          <label>Account value for sizing<input name="account_value" inputMode="decimal" defaultValue={s.account_value ?? ""} placeholder="e.g. 25000" style={{ width: 130 }} /></label>
          <button type="submit" style={{ alignSelf: "flex-end" }}>Save</button>
          <span className="muted" style={{ alignSelf: "flex-end" }}>
            {equity != null ? <>Sizing equity <b>{money(equity, 0)}</b> = {money(s.account_value, 0)} set {s.account_set_at} + closed P&amp;L since</> : "Not set"}
          </span>
        </form>
        <p>
          Closed trades: <b>{closed.length}</b> · win rate {closed.length ? pct(wins / closed.length, 0, 100) : "—"} · realized{" "}
          <b className={signClass(realized)}>{money(realized, 0)}</b>
          {closed.length > 0 && <> · average {num(closed.reduce((a, t) => a + (rOf(t) ?? 0), 0) / closed.length, 2)}R</>}
        </p>
        {closed.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ticker</th><th>Entry</th><th>Exit</th><th>Shares</th><th>Bought</th><th>Sold</th><th>P&amp;L</th><th>R</th><th>Why</th><th></th></tr></thead>
              <tbody>{closed.slice(0, 50).map((t) => (
                <tr key={t.id}>
                  <td>{t.ticker}</td><td>{t.entry_d}</td><td>{t.exit_d}</td><td>{num(t.shares, 0)}</td><td>{num(t.entry)}</td><td>{num(t.exit)}</td>
                  <td className={signClass(tradePnl(t))}>{money(tradePnl(t), 0)}</td><td>{num(rOf(t), 2)}</td>
                  <td>{EXIT_LABEL[t.exit_reason ?? ""] ?? t.exit_reason}</td>
                  <td><form action={undoTrade}><input type="hidden" name="id" value={t.id} /><button type="submit" className="ghost">Reopen</button></form></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        {scan?.regime && (
          <p>
            Market: {scan.regime.ticker} {num(scan.regime.close)} vs {p.slow_ma}-day average {num(scan.regime.ma)}:{" "}
            {scan.regime.ok ? <span className="tag tag-buy">ABOVE</span> : <span className="tag tag-sell">BELOW</span>}
            {!scan.regime.filter && <span className="muted"> (filter off)</span>}
          </p>
        )}
        {scan?.funnel && (
          <details>
            <summary>How today&apos;s list was built</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Step</th><th>Remaining</th></tr></thead>
                <tbody>{scan.funnel.map((f, i) => <tr key={i}><td>{i + 1}. {f.step}</td><td>{f.count}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="muted">Scanned {new Date(scan.created_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET.</p>
          </details>
        )}

        <details style={{ marginTop: 8 }}>
          <summary>Strategy settings</summary>
          <p className="muted">Same names and meaning as the backtester&apos;s pullback strategy. Changes apply from the next scan.</p>
          <form action={savePbSettings}>
            {[...new Set(PB_FIELDS.map((f) => f.group))].map((g) => (
              <fieldset key={g} style={{ border: 0, padding: 0, margin: "10px 0" }}>
                <legend className="muted">{g}</legend>
                <div className="filters">
                  {PB_FIELDS.filter((f) => f.group === g).map((f) =>
                    typeof p[f.key] === "boolean" ? (
                      <label key={f.key} className="check"><input type="checkbox" name={f.key} defaultChecked={p[f.key] as boolean} /> {f.label}</label>
                    ) : f.choices ? (
                      <label key={f.key} title={f.help}>{f.label}
                        <select name={f.key} defaultValue={String(p[f.key])}>{f.choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                      </label>
                    ) : (
                      <label key={f.key} title={f.help}>{f.label}<input name={f.key} defaultValue={String(p[f.key])} inputMode={typeof p[f.key] === "number" ? "decimal" : undefined} /></label>
                    ),
                  )}
                </div>
              </fieldset>
            ))}
            <button type="submit">Save settings</button>
          </form>
        </details>
      </section>
    </main>
  );
}

function TradeCard({ t, st, today }: { t: { id: number; ticker: string; entry_d: string; entry: number; shares: number; stop: number; target: number }; st: ExitStatus; today: string }) {
  const exit = st.action === "EXIT";
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="row">
        <span className={`tag ${exit ? "tag-sell" : "tag-hold"}`}>{exit ? "SELL" : "HOLD"}</span>
        <Link href={`/t/${t.ticker}`}><b>{t.ticker}</b></Link>
        <span>{num(t.shares, 0)} sh @ {num(t.entry)}</span>
        <span className="muted">since {t.entry_d} · stop {num(t.stop)} · target {num(t.target)} · close {num(st.close)}</span>
        {st.unrealized != null && <span className={signClass(st.unrealized)}>{money(st.unrealized, 0)}</span>}
      </div>
      <div className={exit ? "" : "muted"}>{exit && <b>{EXIT_LABEL[st.reason ?? ""]}: </b>}{st.note}</div>
      <div className="row" style={{ marginTop: 6 }}>
        <form action={logSell} className="row">
          <input type="hidden" name="id" value={t.id} />
          <label>Sale price<input name="exit" inputMode="decimal" style={{ width: 90 }} required /></label>
          <label>Date<input type="date" name="exit_d" defaultValue={today} /></label>
          <label>Why
            <select name="reason" defaultValue={st.reason ?? "manual"}>
              {Object.entries(EXIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button type="submit" style={{ alignSelf: "flex-end" }}>Sold</button>
        </form>
        <details>
          <summary className="muted">Edit / undo</summary>
          <form action={editLevels} className="row">
            <input type="hidden" name="id" value={t.id} />
            <label>Stop<input name="stop" inputMode="decimal" defaultValue={t.stop} style={{ width: 90 }} /></label>
            <label>Target<input name="target" inputMode="decimal" defaultValue={t.target} style={{ width: 90 }} /></label>
            <button type="submit" className="ghost" style={{ alignSelf: "flex-end" }}>Save</button>
          </form>
          <form action={undoTrade}><input type="hidden" name="id" value={t.id} /><button type="submit" className="danger">Delete this trade</button></form>
        </details>
      </div>
    </div>
  );
}
