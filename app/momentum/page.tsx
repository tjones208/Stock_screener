import Link from "next/link";
import { db } from "@/lib/db";
import { big, money, num, pct } from "@/lib/format";
import { capitalAndSlots, MOM_FIELDS } from "@/lib/momentum/config";
import { getMomConfig, loadCalendar } from "@/lib/momentum/jobs";
import { addTradingDays } from "@/lib/momentum/calendar";
import { planPortfolio, type Candidate, type Plan } from "@/lib/momentum/sizing";
import type { Regime } from "@/lib/momentum/regime";
import { clearFlag, dropTicket, fillTicket, quoteTickets, saveMomConfig, uploadEarnings } from "./actions";
import type { Ticket } from "@/lib/momentum/tickets";

export const dynamic = "force-dynamic";

type Snap = {
  ticker: string; close: number; market_cap: number | null; sic2: string | null; comp_rank: number;
  mom: number; h52: number; days_since_high: number; mom_pct: number; h52_pct: number; composite: number;
  sigma63: number | null; atr20: number | null; entry_ok: boolean; hold_ok: boolean;
};
type Flag = { ticker: string; kind: string; d: string; detail: string | null; excludes: boolean };

const FLAG_LABEL: Record<string, string> = {
  big_move: "Big move", missing_day: "Missing day", zero_volume: "Zero volume",
  split_unrepaired: "Split not repaired", buyout_news: "Buyout news", buyout_review: "Buyout? (review)",
};

export default async function Momentum({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const sp = await searchParams;
  const cfg = await getMomConfig();
  const { I, N } = capitalAndSlots(cfg);
  const { data: runs } = await db().from("ss_mom_runs").select("*").order("signal_date", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  const run = runs?.[0];
  const [snap, flags, earnings, news, splits] = await Promise.all([
    run
      ? db().from("ss_mom_snapshots").select("ticker, close, market_cap, sic2, comp_rank, mom, h52, days_since_high, mom_pct, h52_pct, composite, sigma63, atr20, entry_ok, hold_ok")
          .eq("signal_date", run.signal_date).order("comp_rank").limit(sp.all ? 1500 : 60)
      : Promise.resolve({ data: [] }),
    db().from("ss_data_flags").select("ticker, kind, d, detail, excludes").eq("cleared", false).order("d", { ascending: false }).limit(500),
    db().from("ss_earnings_calendar").select("ticker", { count: "exact", head: true }),
    db().from("ss_news_days").select("d", { count: "exact", head: true }).gte("d", new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)),
    db().from("ss_splits").select("ticker", { count: "exact", head: true }).eq("needs_repair", true).is("repaired_at", null),
  ]);
  const rows = (snap.data ?? []) as Snap[];
  const [{ data: openTix }, { data: altTix }, { data: doneTix }] = await Promise.all([
    db().from("ss_mom_tickets").select("*").eq("side", "buy").eq("status", "open").order("trade_date").order("comp_rank"),
    db().from("ss_mom_tickets").select("*").eq("side", "buy").eq("status", "alternate").order("signal_date", { ascending: false }).order("alt_order"),
    db().from("ss_mom_tickets").select("*").eq("side", "buy").in("status", ["filled", "dropped", "cancelled"]).order("updated_at", { ascending: false }).limit(15),
  ]);
  const plan = run ? await buildPlan(run.signal_date, cfg, (run.regime as Regime | null)?.riskOn ?? null) : null;
  const allFlags = (flags.data ?? []) as Flag[];
  const blocking = allFlags.filter((f) => f.excludes);
  const review = allFlags.filter((f) => !f.excludes);
  const regime = run?.regime as Regime | null | undefined;
  const funnel = (run?.funnel ?? []) as { step: string; count: number }[];
  const warnings = [...((run?.warnings ?? []) as string[])];
  if (!earnings.count) warnings.push("No earnings calendar uploaded: the earnings blackout rule will be skipped.");
  if (splits.count) warnings.push(`${splits.count} splits are waiting for their bars to be re-fetched; those tickers are excluded until then.`);

  return (
    <main>
      <div className="row spread">
        <h1>Momentum</h1>
        <span className="muted">{run ? `Signals ${run.signal_date} · ${run.kind} run` : "No run yet"}</span>
      </div>
      <p className="muted">
        Monthly momentum rotation: rank liquid large caps by 12-1 month momentum and closeness to the 52-week high, hold the top N
        while SPY is above its 10-month average. Trailing stops, exits, tax rules and the journal come in the next build steps.
      </p>

      {cfg.B < cfg.min_B_stock_version && (
        <div className="notice">B is below {money(cfg.min_B_stock_version, 0)}: stop the stock version and use a momentum ETF with the same regime filter.</div>
      )}

      <div className="grid" style={{ margin: "12px 0" }}>
        <div className="stat"><div className="k">Buying power B</div><div className="v">{money(cfg.B, 0)}</div></div>
        <div className="stat"><div className="k">Investable I</div><div className="v">{money(I, 0)}</div></div>
        <div className="stat"><div className="k">Target positions N</div><div className="v">{N}</div></div>
        <div className="stat"><div className="k">Equity E (risk cap)</div><div className="v">{money(cfg.E, 0)}</div></div>
        <div className="stat">
          <div className="k">Regime (SPY vs {cfg.regime_sma_months}-mo SMA)</div>
          <div className={`v ${regime?.riskOn ? "up" : regime?.riskOn === false ? "down" : ""}`}>
            {regime?.riskOn == null ? "Unknown" : regime.riskOn ? "Risk-on" : "Risk-off"}
          </div>
        </div>
        <div className="stat"><div className="k">Universe</div><div className="v">{funnel.at(-1)?.count ?? "—"}</div></div>
      </div>

      {regime && (
        <p className="muted">
          {regime.reason ?? `SPY month-end ${regime.monthEnd}: ${num(regime.close)} vs ${cfg.regime_sma_months}-month SMA ${num(regime.sma)}.`}
          {" "}Month-end closes: {regime.months.map((m) => `${m.month} ${num(m.close)}`).join(" · ")}
        </p>
      )}

      {warnings.map((w) => <div key={w} className="notice">{w}</div>)}

      <h2>Universe filters</h2>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead><tr><th>Step</th><th>Remaining</th></tr></thead>
          <tbody>{funnel.map((f, i) => <tr key={i}><td>{i + 1}. {f.step}</td><td>{f.count}</td></tr>)}</tbody>
        </table>
      </div>

      <div className="row spread">
        <h2>Ranking</h2>
        <Link href={sp.all ? "/momentum" : "/momentum?all=1"} className="muted">{sp.all ? "Top 60" : "Show all"}</Link>
      </div>
      <p className="muted">
        Entry: momentum percentile ≥ {cfg.entry_mom_pct}, H52 ≥ {cfg.entry_h52}, ≤ {cfg.entry_max_days_since_high} days since the high.
        Hold: momentum percentile ≥ {cfg.hold_mom_pct}, H52 ≥ {cfg.hold_h52}, CompRank ≤ {cfg.hold_comprank_mult * N}.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rank</th><th>Ticker</th><th>Close</th><th>MOM</th><th>H52</th><th>Days since high</th><th>MOM pct</th><th>H52 pct</th>
              <th>Composite</th><th>σ63</th><th>ATR20</th><th>Mkt cap</th><th>SIC</th><th>Entry</th><th>Hold</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticker}>
                <td>{r.comp_rank}</td>
                <td><Link href={`/t/${r.ticker}`}><b>{r.ticker}</b></Link></td>
                <td>{num(r.close)}</td>
                <td>{pct(r.mom, 1, 100)}</td>
                <td>{num(r.h52, 3)}</td>
                <td>{r.days_since_high}</td>
                <td>{num(r.mom_pct, 1)}</td>
                <td>{num(r.h52_pct, 1)}</td>
                <td className="score">{num(r.composite, 1)}</td>
                <td>{pct(r.sigma63, 0, 100)}</td>
                <td>{num(r.atr20)}</td>
                <td>{big(r.market_cap)}</td>
                <td>{r.sic2 ?? "—"}</td>
                <td>{r.entry_ok ? <span className="up">✓</span> : <span className="muted">—</span>}</td>
                <td>{r.hold_ok ? <span className="up">✓</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TicketsSection open={(openTix ?? []) as Ticket[]} alternates={(altTix ?? []) as Ticket[]} done={(doneTix ?? []) as Ticket[]} cfg={cfg} />

      {plan && <PlanSection plan={plan} kind={run?.kind} signalDate={run?.signal_date} chase={cfg.chase_cap_pct} />}

      <h2>Data flags ({blocking.length} blocking, {review.length} to review)</h2>
      <p className="muted">
        Blocking flags keep a stock out of signals until you clear them. Big moves are often real news (earnings, trial results):
        check the chart and clear the ones that aren&apos;t data errors. News sweep: {news.count ?? 0} of the last 90 days scanned.
      </p>
      <FlagTable flags={[...blocking, ...review]} />

      <details className="panel" style={{ marginTop: 12 }}>
        <summary>Earnings calendar ({earnings.count ?? 0} dates)</summary>
        <p className="muted">Upload a CSV from your broker with a ticker (or symbol) column and a report date column. It replaces the current calendar.</p>
        <form action={uploadEarnings} className="row">
          <input type="file" name="file" accept=".csv,text/csv" />
          <button type="submit">Upload</button>
        </form>
      </details>

      <details className="panel" style={{ marginTop: 12 }}>
        <summary>Strategy settings</summary>
        <form action={saveMomConfig}>
          {[...new Set(MOM_FIELDS.map((f) => f.group))].map((g) => (
            <fieldset key={g} style={{ border: 0, padding: 0, margin: "10px 0" }}>
              <legend className="muted">{g}</legend>
              <div className="filters">
                {MOM_FIELDS.filter((f) => f.group === g).map((f) =>
                  typeof cfg[f.key] === "boolean" ? (
                    <label key={f.key} className="check">
                      <input type="checkbox" name={f.key} defaultChecked={cfg[f.key] as boolean} /> {f.label}
                    </label>
                  ) : (
                    <label key={f.key}>{f.label}<input name={f.key} inputMode="decimal" defaultValue={String(cfg[f.key])} /></label>
                  ),
                )}
              </div>
            </fieldset>
          ))}
          <button type="submit">Save settings</button>
        </form>
      </details>
    </main>
  );
}

function FlagTable({ flags }: { flags: Flag[] }) {
  if (!flags.length) return <p className="muted">No open flags.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Ticker</th><th>Flag</th><th>Date</th><th style={{ textAlign: "left" }}>Detail</th><th></th></tr></thead>
        <tbody>
          {flags.map((f) => (
            <tr key={`${f.ticker}|${f.kind}|${f.d}`}>
              <td><Link href={`/t/${f.ticker}`}><b>{f.ticker}</b></Link></td>
              <td>{f.excludes ? <span className="down">{FLAG_LABEL[f.kind] ?? f.kind}</span> : <span className="pill">{FLAG_LABEL[f.kind] ?? f.kind}</span>}</td>
              <td>{f.d}</td>
              <td style={{ textAlign: "left", whiteSpace: "normal", minWidth: 240 }}>{f.detail}</td>
              <td>
                <form action={clearFlag}>
                  <input type="hidden" name="ticker" value={f.ticker} />
                  <input type="hidden" name="kind" value={f.kind} />
                  <input type="hidden" name="d" value={f.d} />
                  <button type="submit" className="ghost">Clear</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function buildPlan(t: string, cfg: Awaited<ReturnType<typeof getMomConfig>>, riskOn: boolean | null): Promise<Plan> {
  const [{ data: cands }, cal] = await Promise.all([
    db().from("ss_mom_snapshots").select("ticker, comp_rank, close, sigma63, atr20, sic2, entry_ok")
      .eq("signal_date", t).eq("entry_ok", true).order("comp_rank").limit(1000),
    loadCalendar(),
  ]);
  // Earnings blackout: reports in the next N trading days after the signal date.
  const until = addTradingDays(cal, t, cfg.earnings_blackout_days);
  const { data: rep } = await db().from("ss_earnings_calendar").select("ticker").gt("report_date", t).lte("report_date", until);
  // Holdings and wash-sale blocks come from the journal (build step 8); none are recorded yet.
  return planPortfolio({ cfg, candidates: (cands ?? []) as Candidate[], riskOn, earnings: new Set((rep ?? []).map((r) => r.ticker)) });
}

function PlanSection({ plan, kind, signalDate, chase }: { plan: Plan; kind?: string; signalDate?: string; chase: number }) {
  const total = plan.buys.reduce((a, b) => a + b.amount, 0);
  return (
    <>
      <h2>Planned buys</h2>
      <p className="muted">
        {kind === "monthly" || kind === "weekly"
          ? `Buy list from the ${kind} signals of ${signalDate}.`
          : `Preview only: ${signalDate} isn't a rebalance date, so this shows what a rebalance on its close would buy.`}
        {" "}Sized at the chase cap (S × {num(1 + chase, 2)}), the most a ticket may pay; the 9:45 ticket recomputes shares at the real limit.
        {" "}{plan.buys.length} of {plan.openSlots} open slots · {money(total, 0)} of {money(plan.I, 0)} investable.
      </p>
      {plan.message && <div className="notice">{plan.message}</div>}
      {plan.buys.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Ticker</th><th>Rank</th><th>Sector</th><th>σ63</th><th>Weight</th><th>Target T</th><th>Signal S</th><th>Cap</th><th>Stop dist. D</th><th>Target sh.</th><th>Risk-cap sh.</th><th>Shares</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {plan.buys.map((b) => (
                <tr key={b.ticker}>
                  <td><Link href={`/t/${b.ticker}`}><b>{b.ticker}</b></Link></td>
                  <td>{b.comp_rank}</td>
                  <td>{b.sector}</td>
                  <td>{pct(b.sigma63, 0, 100)}</td>
                  <td>{pct(b.w, 2, 100)}</td>
                  <td>{money(b.T)}</td>
                  <td>{num(b.S)}</td>
                  <td>{num(b.cap)}</td>
                  <td>{num(b.D)}</td>
                  <td>{b.byTarget}</td>
                  <td>{b.byRisk}</td>
                  <td className="score">{b.shares}</td>
                  <td>{money(b.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {plan.alternates.length > 0 && (
        <p><b>Alternates:</b> {plan.alternates.map((a) => `${a.ticker} (#${a.comp_rank})`).join(", ")}</p>
      )}
      {plan.earningsWatch.length > 0 && (
        <p><b>Earnings watch (skipped this time):</b> {plan.earningsWatch.map((a) => a.ticker).join(", ")}</p>
      )}
      {plan.skipped.length > 0 && (
        <details className="panel">
          <summary>Skipped ({plan.skipped.length})</summary>
          <ul>{plan.skipped.map((k) => <li key={k.ticker}>{k.ticker} (#{k.comp_rank}): {k.reason}</li>)}</ul>
        </details>
      )}
    </>
  );
}

function TicketsSection({ open, alternates, done, cfg }: { open: Ticket[]; alternates: Ticket[]; done: Ticket[]; cfg: Awaited<ReturnType<typeof getMomConfig>> }) {
  const tradeDay = open[0]?.trade_date;
  const chrome =
    `At 9:45 AM ET, open my brokerage account and look up the current bid and ask for these tickers: ${open.map((t) => t.ticker).join(", ")}. ` +
    `Then open the Momentum tab of my stock screener, find the "Tickets" table and, for each ticker, type the bid into its Bid box and the ask into its Ask box ` +
    `(the boxes are labelled "<TICKER> bid" and "<TICKER> ask"). Click "Calculate limits" and read me back each ticker's LP1, LP2 and shares. Do not place any orders.`;
  return (
    <>
      <h2>Tickets{tradeDay ? ` for ${tradeDay}` : ""}</h2>
      {!open.length ? (
        <p className="muted">No open buy tickets. They are created the morning after a week-end or month-end signal (6:15am ET) while the regime is risk-on and slots are free.</p>
      ) : (
        <>
          <ol className="muted" style={{ paddingLeft: 18 }}>
            <li>Sells first at 9:45 ET; place buys after the sells fill.</li>
            <li>At 9:45 enter each bid and ask below and press Calculate limits.</li>
            <li>Place a day limit at LP1. After 15 minutes unfilled, move it to LP2 and leave it working until 3:45 PM, then cancel.</li>
            <li>If the ask is above the cap there is no buy today; the ticket retries next session with the same cap. On retry day {cfg.entry_retry_reset_day} the entry test is re-checked (S resets if it passes; otherwise the next alternate takes the slot). After {cfg.entry_max_retry_days} sessions unfilled it is dropped.</li>
            <li>Alternative: a broker VWAP order 9:45–11:00 ET with its limit at the cap.</li>
            <li>Cash account: don&apos;t sell a new position before the cash used to buy it has settled (T+1).</li>
          </ol>
          <form action={quoteTickets}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Ticker</th><th>Rank</th><th>Retry</th><th>S</th><th>Cap</th><th>Target T</th><th>Bid</th><th>Ask</th><th>LP1</th><th>Shares @LP1</th><th>LP2</th><th>Shares @LP2</th><th style={{ textAlign: "left" }}>Note</th></tr>
                </thead>
                <tbody>
                  {open.map((t) => (
                    <tr key={t.id}>
                      <td><Link href={`/t/${t.ticker}`}><b>{t.ticker}</b></Link><input type="hidden" name="id" value={t.id} /></td>
                      <td>{t.comp_rank}</td>
                      <td>{t.retry_day}/{cfg.entry_max_retry_days}</td>
                      <td>{num(t.s_close)}</td>
                      <td>{num(t.cap)}</td>
                      <td>{money(t.t_target)}</td>
                      <td><input name={`bid_${t.id}`} aria-label={`${t.ticker} bid`} inputMode="decimal" defaultValue={t.bid ?? ""} style={{ width: 84 }} /></td>
                      <td><input name={`ask_${t.id}`} aria-label={`${t.ticker} ask`} inputMode="decimal" defaultValue={t.ask ?? ""} style={{ width: 84 }} /></td>
                      <td className="score">{t.lp1 != null ? num(t.lp1) : "—"}</td>
                      <td>{t.shares_lp1 ?? "—"}</td>
                      <td>{t.lp2 != null ? num(t.lp2) : "—"}</td>
                      <td>{t.shares_lp2 ?? "—"}</td>
                      <td style={{ textAlign: "left", whiteSpace: "normal", minWidth: 200 }}>{t.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="submit" style={{ marginTop: 8 }}>Calculate limits</button>
          </form>

          <h3>Record fills</h3>
          <div className="card-list">
            {open.map((t) => (
              <div key={t.id} className="row panel">
                <b style={{ minWidth: 60 }}>{t.ticker}</b>
                <form action={fillTicket} className="row">
                  <input type="hidden" name="id" value={t.id} />
                  <label>Avg fill F<input name="price" inputMode="decimal" style={{ width: 90 }} /></label>
                  <label>Shares<input name="shares" inputMode="decimal" defaultValue={t.shares_lp1 ?? t.planned_shares ?? ""} style={{ width: 80 }} /></label>
                  <label>Time (NY)<input type="datetime-local" name="filled_at" /></label>
                  <button type="submit" style={{ alignSelf: "flex-end" }}>Filled</button>
                </form>
                <form action={dropTicket}>
                  <input type="hidden" name="id" value={t.id} />
                  <button type="submit" className="danger">Drop → next alternate</button>
                </form>
              </div>
            ))}
          </div>

          <details className="panel" style={{ marginTop: 12 }}>
            <summary>Claude in Chrome prompt (copy at 9:45)</summary>
            <textarea readOnly value={chrome} rows={5} style={{ width: "100%", marginTop: 8 }} />
          </details>
        </>
      )}
      {alternates.length > 0 && (
        <p><b>Alternates:</b> {alternates.map((a) => `${a.ticker} (#${a.comp_rank})`).join(", ")}</p>
      )}
      {done.length > 0 && (
        <details className="panel" style={{ marginTop: 12 }}>
          <summary>Recent tickets ({done.length})</summary>
          <ul>{done.map((t) => <li key={t.id}>{t.ticker} · {t.status} · {t.signal_date} {t.kind}{t.note ? ` · ${t.note}` : ""}</li>)}</ul>
        </details>
      )}
    </>
  );
}
