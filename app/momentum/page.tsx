import Link from "next/link";
import { db } from "@/lib/db";
import { big, money, num, pct } from "@/lib/format";
import { capitalAndSlots, MOM_CHOICES, MOM_FIELDS, riskBudget } from "@/lib/momentum/config";
import { journal } from "@/lib/momentum/equity";
import { idleCash, type EquityRow } from "@/lib/momentum/journal";
import { closedLots } from "@/lib/momentum/positions";
import { washBlocked } from "@/lib/momentum/risk";
import { gtcNeedsUpdate } from "@/lib/momentum/stops";
import { getMomConfig, loadCalendar } from "@/lib/momentum/jobs";
import { addTradingDays } from "@/lib/momentum/calendar";
import { planPortfolio, type Candidate, type Plan } from "@/lib/momentum/sizing";
import { tickerSectors, withSectors } from "@/lib/momentum/sector-db";
import { sectorLabel } from "@/lib/momentum/sector-key";
import type { Regime } from "@/lib/momentum/regime";
import { addPosition, assignCall, buyBackCall, expireCall, sellCall, clearFlag, dropTicket, exitTicket, fillTicket, markDisasterPosted, quoteExits, quoteTickets, saveMomConfig, undoLot, uploadEarnings } from "./actions";
import { previewManual, type ManualPreview } from "@/lib/momentum/manual";
import { TRIGGER_LABEL } from "@/lib/momentum/stops";
import type { Ticket } from "@/lib/momentum/tickets";

export const dynamic = "force-dynamic";

type Snap = {
  ticker: string; close: number; market_cap: number | null; sic2: string | null; comp_rank: number;
  mom: number; h52: number; days_since_high: number; mom_pct: number; h52_pct: number; composite: number;
  sigma63: number | null; atr20: number | null; entry_ok: boolean; hold_ok: boolean;
  sigma252: number | null; composite_classic: number | null; composite_risk_adj: number | null;
  held_outside_universe: boolean; outside_reason: string | null; hold_reason: string | null; entry_reason: string | null;
};
type Flag = { ticker: string; kind: string; d: string; detail: string | null; excludes: boolean };

const FLAG_LABEL: Record<string, string> = {
  big_move: "Big move", missing_day: "Missing day", zero_volume: "Zero volume",
  split_unrepaired: "Split not repaired", buyout_news: "Buyout news", buyout_review: "Buyout? (review)",
};

export default async function Momentum({ searchParams }: { searchParams: Promise<{ all?: string; add?: string; price?: string; shares?: string; added?: string }> }) {
  const sp = await searchParams;
  const cfg = await getMomConfig();
  const { I, N } = capitalAndSlots(cfg);
  const { data: runs } = await db().from("ss_mom_runs").select("*").order("signal_date", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  const run = runs?.[0];
  const [snap, flags, earnings, news, splits] = await Promise.all([
    run
      ? db().from("ss_mom_snapshots").select("ticker, close, market_cap, sic2, comp_rank, mom, h52, days_since_high, mom_pct, h52_pct, composite, sigma63, atr20, entry_ok, hold_ok, sigma252, composite_classic, composite_risk_adj, held_outside_universe, outside_reason, hold_reason, entry_reason")
          .eq("signal_date", run.signal_date).order("comp_rank").limit(sp.all ? 1500 : 60)
      : Promise.resolve({ data: [] }),
    db().from("ss_data_flags").select("ticker, kind, d, detail, excludes").eq("cleared", false).order("d", { ascending: false }).limit(500),
    db().from("ss_earnings_calendar").select("ticker", { count: "exact", head: true }),
    db().from("ss_news_days").select("d", { count: "exact", head: true }).gte("d", new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)),
    db().from("ss_splits").select("ticker", { count: "exact", head: true }).eq("needs_repair", true).is("repaired_at", null),
  ]);
  const rows = (snap.data ?? []) as Snap[];
  const rowSectors = await tickerSectors(rows.map((r) => r.ticker));
  const [{ data: openTix }, { data: altTix }, { data: doneTix }] = await Promise.all([
    db().from("ss_mom_tickets").select("*").eq("side", "buy").eq("status", "open").order("trade_date").order("comp_rank"),
    db().from("ss_mom_tickets").select("*").eq("side", "buy").eq("status", "alternate").order("signal_date", { ascending: false }).order("alt_order"),
    db().from("ss_mom_tickets").select("*").eq("side", "buy").in("status", ["filled", "dropped", "cancelled"]).order("updated_at", { ascending: false }).limit(15),
  ]);
  const { data: lotRows } = await db().from("ss_mom_lots").select("*").is("exit_date", null).order("ticker").order("filled_at");
  const lots = (lotRows ?? []) as LotView[];
  const { data: lastBars } = lots.length
    ? await db().from("ss_indicators").select("ticker, close, as_of").in("ticker", [...new Set(lots.map((l) => l.ticker))])
    : { data: [] };
  const lastClose = new Map((lastBars ?? []).map((b) => [b.ticker, b.close as number]));
  const { data: sellRows } = await db().from("ss_mom_tickets").select("*").eq("side", "sell").eq("status", "open").order("urgent", { ascending: false }).order("ticker");
  const [{ data: callRows }, { data: ideaRows }] = await Promise.all([
    db().from("ss_mom_calls").select("*").in("status", ["open", "assign_pending"]).order("expiration"),
    db().from("ss_mom_call_ideas").select("*").order("ticker"),
  ]);
  const calls = (callRows ?? []) as CallView[];
  const ideas = (ideaRows ?? []) as IdeaView[];
  const preview = sp.add ? await previewManual(sp.add, Number(sp.price) || undefined, Number(sp.shares) || undefined) : null;
  const added = sp.added ? lots.find((l) => l.id === Number(sp.added)) ?? null : null;
  // Upcoming reports for what you hold or are about to buy.
  const watchTickers = [...new Set([...lots.map((l) => l.ticker), ...(openTix ?? []).map((b) => b.ticker as string), ...(sellRows ?? []).map((x) => x.ticker as string)])];
  const { data: upcoming } = watchTickers.length
    ? await db().from("ss_earnings_calendar").select("ticker, report_date, hour, eps_estimate, source")
        .in("ticker", watchTickers).gte("report_date", new Date().toISOString().slice(0, 10)).order("report_date").limit(100)
    : { data: [] };
  const runState = run?.regime as (Regime & { volScale?: number; spyVol?: number | null; holdCutoff?: number; universe?: number }) | null | undefined;
  const m = runState?.volScale ?? 1;
  const plan = run ? await buildPlan(run.signal_date, cfg, runState?.riskOn ?? null, m) : null;
  const jr = await journal(run?.signal_date ?? new Date().toISOString().slice(0, 10));
  const lastEq = jr.rows.at(-1);
  const investedValue = lots.reduce((a, l) => a + l.shares * (lastClose.get(l.ticker) ?? l.fill_price), 0);
  const idle = idleCash(investedValue, I);
  const allFlags = (flags.data ?? []) as Flag[];
  const blocking = allFlags.filter((f) => f.excludes);
  const review = allFlags.filter((f) => !f.excludes);
  const regime = run?.regime as Regime | null | undefined;
  const funnel = (run?.funnel ?? []) as { step: string; count: number }[];
  const warnings = [...((run?.warnings ?? []) as string[])];
  const { data: syncRow } = await db().from("ss_settings").select("value").eq("key", "earnings_sync").maybeSingle();
  const earningsSync = syncRow?.value as { from: string; to: string; rows: number; synced_at: string } | undefined;
  if (!earnings.count) {
    warnings.push(process.env.FINNHUB_API_KEY
      ? "The earnings calendar hasn't synced yet (it runs with the 6:15am ET job); until then the earnings blackout rule is skipped."
      : "No earnings calendar: add FINNHUB_API_KEY in Vercel (free key from finnhub.io) or upload a CSV. Until then the earnings blackout rule is skipped.");
  }
  if (splits.count) warnings.push(`${splits.count} splits are waiting for their bars to be re-fetched; those tickers are excluded until then.`);

  const sells = (sellRows ?? []) as SellTicket[];
  const buys = (openTix ?? []) as Ticket[];
  const alts = (altTix ?? []) as Ticket[];
  // Buy safety (lib/momentum/quality.ts): the latest run's data-quality gate and earnings check.
  const quality = run?.quality as { gate_ok?: boolean; gate_reasons?: string[]; compared_to?: string | null; earnings_ok?: boolean; earnings_reason?: string | null } | null;
  const uncheckedBuys = buys.filter((t) => t.earnings_unchecked);
  const earningsUnchecked = uncheckedBuys.length > 0 || quality?.earnings_ok === false;
  const done = (doneTix ?? []) as Ticket[];
  const rebalance = run?.kind === "weekly" || run?.kind === "monthly";
  const altList = alts.length
    ? alts.map((a) => ({ ticker: a.ticker, comp_rank: a.comp_rank ?? 0 }))
    : (plan?.alternates ?? []).map((a) => ({ ticker: a.ticker, comp_rank: a.comp_rank }));
  const watchCount = altList.length + (plan?.earningsWatch.length ?? 0) + (!rebalance ? plan?.buys.length ?? 0 : 0);
  // One status per ticker so the ranking says what each name is to you.
  const status = new Map<string, Status>();
  for (const r of rows) if (r.entry_ok) status.set(r.ticker, "watch");
  for (const a of altList) status.set(a.ticker, "alternate");
  for (const l of lots) status.set(l.ticker, "held");
  for (const b of buys) status.set(b.ticker, "buy");
  for (const x of sells) status.set(x.ticker, "sell");

  return (
    <main>
      <div className="row spread">
        <h1>Momentum</h1>
        <span className="muted">{run ? `Signals ${run.signal_date} · ${run.kind} run` : "No run yet"}</span>
      </div>

      <nav className="mnav">
        <a href="#sell"><span className="tag tag-sell">SELL</span> {sells.length}</a>
        <a href="#buy"><span className="tag tag-buy">BUY</span> {buys.length}</a>
        <a href="#calls"><span className="tag tag-call">CALL</span> {ideas.filter((i) => i.exp_latest).length + calls.length}</a>
        <a href="#hold"><span className="tag tag-hold">HOLD</span> {lots.length}</a>
        <a href="#watch"><span className="tag tag-watch">WATCH</span> {watchCount}</a>
        <a href="#info"><span className="tag tag-info">INFO</span></a>
      </nav>

      {quality?.gate_ok === false && (
        <div className="notice notice-danger">
          <b>New buys blocked for {run?.signal_date}.</b> The data-quality gate failed, so no new buy tickets, promotions or top-ups
          were created; stops, exits and open tickets still run. {(quality.gate_reasons ?? []).join(" · ")}
        </div>
      )}
      {earningsUnchecked && (
        <div className="notice notice-danger">
          <b>Earnings unchecked.</b> {quality?.earnings_reason ?? "The earnings calendar was unavailable when these tickets were made."}{" "}
          {uncheckedBuys.length ? `${uncheckedBuys.length} open buy ticket${uncheckedBuys.length === 1 ? " wasn't" : "s weren't"} screened` : "New buy tickets won't be screened"} for
          earnings in the next {cfg.earnings_blackout_days} trading days. Check each name&apos;s report date before buying.
        </div>
      )}

      {jr.kill.active && (
        <div className="notice notice-danger">
          <b>Kill switch.</b> The strategy&apos;s 12-month after-tax return ({pct(jr.kill.mine, 1, 100)}) trails MTUM ({pct(jr.kill.mtum, 1, 100)}).
          Consider switching to the ETF version.
        </div>
      )}
      {idle > 0 && (
        <div className="notice">
          Idle cash: only {money(investedValue, 0)} of {money(I, 0)} investable is in positions. Park the idle {money(idle, 0)} in {cfg.cash_etf},
          or confirm your broker&apos;s cash sweep pays interest. (Informational: no tickets.)
        </div>
      )}

      {cfg.B < cfg.min_B_stock_version && (
        <div className="notice">B is below {money(cfg.min_B_stock_version, 0)}: stop the stock version and use a momentum ETF with the same regime filter.</div>
      )}

      <div className="grid" style={{ margin: "12px 0" }}>
        <div className="stat">
          <div className="k">Regime (SPY vs {cfg.regime_sma_months}-mo SMA)</div>
          <div className={`v ${regime?.riskOn ? "up" : regime?.riskOn === false ? "down" : ""}`}>
            {regime?.riskOn == null ? "Unknown" : regime.riskOn ? "Risk-on: buys allowed" : "Risk-off: no buys"}
          </div>
        </div>
        <div className="stat">
          <div className="k">Volatility brake m (SPY {runState?.spyVol != null ? pct(runState.spyVol, 0, 100) : "—"} vol)</div>
          <div className={`v ${m < cfg.vol_trim_trigger ? "down" : m < 1 ? "" : "up"}`}>
            {num(m, 2)}{m < 1 ? ` · buys at ${Math.round(m * 100)}% of target` : ""}{m < cfg.vol_trim_trigger ? " · trims on" : ""}
          </div>
        </div>
        <div className="stat"><div className="k">Positions / target N</div><div className="v">{new Set(lots.map((l) => l.ticker)).size} / {N}</div></div>
        <div className="stat"><div className="k">Buying power B · investable I</div><div className="v">{money(cfg.B, 0)} · {money(I, 0)}</div></div>
        <div className="stat"><div className="k">Universe</div><div className="v">{funnel.at(-1)?.count ?? "—"} stocks</div></div>
      </div>

      <Section id="sell" tag="sell" title="Sell today" count={sells.length} open={sells.length > 0}
        hint={sells.length ? "Exit orders to place at 9:45 ET, before any buys" : "Nothing to sell"}>
        <ExitSection sells={sells} callTickers={new Set(calls.map((c) => c.ticker))} />
      </Section>

      <Section id="buy" tag="buy" title="Buy today" count={buys.length} open={buys.length > 0}
        hint={buys.length ? "Buy orders to place after the sells fill" : "No buy orders. They appear the morning after a week- or month-end signal"}>
        <TicketsSection open={buys} cfg={cfg} />
      </Section>

      <Section id="calls" tag="call" title="Covered calls" count={ideas.filter((i) => i.exp_latest).length + calls.length}
        open={ideas.some((i) => i.exp_latest) || calls.some((c) => c.status === "assign_pending")}
        hint="Positions with 100+ shares you can sell a call on in Robinhood, and the calls you've recorded">
        <CallsSection ideas={ideas} calls={calls} lastClose={lastClose} cfg={cfg} />
      </Section>

      <Section id="hold" tag="hold" title="Your positions" count={lots.length} open={lots.length > 0 || !!preview || !!added}
        hint={lots.length ? "What you own, with today's stop and disaster stop" : "No positions yet"}>
        {added && <AddedNotice lot={added} />}
        <AddForm preview={preview} />
        <PositionsSection lots={lots} lastClose={lastClose} />
      </Section>

      <div id="watch" />
      <Section tag="watch" title="Alternates" count={altList.length} open={false}
        hint="Backups: not orders. One becomes a buy only if a buy ticket is dropped">
        {altList.length ? (
          <ol>{altList.map((a) => <li key={a.ticker}><Link href={`/t/${a.ticker}`}><b>{a.ticker}</b></Link> <span className="muted">rank #{a.comp_rank}</span> <AddLink ticker={a.ticker} /></li>)}</ol>
        ) : <p className="muted">No alternates.</p>}
      </Section>
      <Section tag="watch" title="Earnings watch" count={plan?.earningsWatch.length ?? 0} open={false}
        hint="Would qualify, but report earnings too soon: skipped this time, not orders">
        {plan?.earningsWatch.length
          ? <p>{plan.earningsWatch.map((a) => a.ticker).join(", ")}</p>
          : <p className="muted">{earnings.count ? "None." : "No earnings calendar yet (see Info → Earnings calendar)."}</p>}
      </Section>
      {plan && !rebalance && (
        <Section tag="watch" title="Next rebalance preview" count={plan.buys.length} open={false}
          hint={`Not orders: what a rebalance on ${run?.signal_date}'s close would buy`}>
          <PlanSection plan={plan} kind={run?.kind} signalDate={run?.signal_date} chase={cfg.chase_cap_pct} budget={riskBudget(cfg)} basis={cfg.risk_basis === "E" ? `${pct(cfg.max_risk_pct_of_E, 1, 100)} of equity E` : `${pct(cfg.max_risk_pct_of_B, 1, 100)} of buying power B`} />
        </Section>
      )}

      <div id="info" />
      <Section tag="info" title="Ranking" count={rows.length} open={false} hint="Every stock in the universe, best first, with what it is to you">
        <p className="muted">
          Entry test: momentum percentile ≥ {cfg.entry_mom_pct}, H52 ≥ {cfg.entry_h52}, ≤ {cfg.entry_max_days_since_high} days since the high.
          Entry also needs 12-1 momentum above {pct(cfg.abs_mom_min, 0, 100)} and no open buyout review.
          Hold test: momentum percentile ≥ {cfg.hold_mom_pct}, H52 ≥ {cfg.hold_h52}, CompRank ≤ {runState?.holdCutoff ?? cfg.hold_comprank_mult * N}
          {" "}(the larger of {cfg.hold_comprank_mult} × N = {cfg.hold_comprank_mult * N} and the top {pct(cfg.hold_rank_pct, 0, 100)} of the universe).
          Ranking: {cfg.rank_method === "risk_adj" ? "risk-adjusted (0.75 × percentile of momentum ÷ σ252 + 0.25 × H52 percentile)" : "classic (50/50 momentum and H52 percentiles)"}.
          {" "}<Link href={sp.all ? "/momentum" : "/momentum?all=1"}>{sp.all ? "Show top 60" : "Show all"}</Link>
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rank</th><th>Ticker</th><th>Status</th><th>Close</th><th>MOM</th><th>H52</th><th>Days since high</th><th>MOM pct</th><th>H52 pct</th>
                <th>Composite</th><th title="0.5 × MOM pct + 0.5 × H52 pct">Classic</th><th title="0.75 × pct(MOM ÷ σ252) + 0.25 × H52 pct">Risk-adj</th><th>σ63</th><th>ATR20</th><th>Mkt cap</th><th>Sector</th><th>SIC</th><th>Entry</th><th>Hold</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticker}>
                  <td>{r.comp_rank}</td>
                  <td><Link href={`/t/${r.ticker}`}><b>{r.ticker}</b></Link></td>
                  <td style={{ textAlign: "left" }}><StatusTag s={status.get(r.ticker)} /></td>
                  <td>{num(r.close)}</td>
                  <td>{pct(r.mom, 1, 100)}</td>
                  <td>{num(r.h52, 3)}</td>
                  <td>{r.days_since_high}</td>
                  <td>{num(r.mom_pct, 1)}</td>
                  <td>{num(r.h52_pct, 1)}</td>
                  <td className="score">{num(r.composite, 1)}</td>
                  <td>{num(r.composite_classic, 1)}</td>
                  <td>{num(r.composite_risk_adj, 1)}</td>
                  <td>{pct(r.sigma63, 0, 100)}</td>
                  <td>{num(r.atr20)}</td>
                  <td>{big(r.market_cap)}</td>
                  <td style={{ textAlign: "left" }}>{sectorLabel(rowSectors.get(r.ticker))}</td>
                  <td className="muted">{r.sic2 ?? "—"}</td>
                  <td title={r.entry_reason ?? ""}>{r.entry_ok ? <span className="up">✓</span> : <span className="muted">—</span>}</td>
                  <td title={r.hold_reason ?? ""}>{r.hold_ok ? <span className="up">✓</span> : <span className="muted">—</span>}
                    {r.held_outside_universe && <span className="tag tag-watch" title={r.outside_reason ?? ""} style={{ marginLeft: 4 }}>HELD · OUTSIDE UNIVERSE</span>}</td>
                  <td><AddLink ticker={r.ticker} held={status.get(r.ticker) === "held"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {plan && rebalance && (
        <Section tag="info" title="Buy list sizing" count={plan.buys.length} open={false} hint={`How today's buy orders were sized from the ${run?.kind} signal`}>
          <PlanSection plan={plan} kind={run?.kind} signalDate={run?.signal_date} chase={cfg.chase_cap_pct} budget={riskBudget(cfg)} basis={cfg.risk_basis === "E" ? `${pct(cfg.max_risk_pct_of_E, 1, 100)} of equity E` : `${pct(cfg.max_risk_pct_of_B, 1, 100)} of buying power B`} />
        </Section>
      )}

      <Section tag="info" title="Journal & benchmark" count={jr.rows.length} open={false} hint="Equity curve vs SPY and MTUM, after-tax returns and trade stats">
        <JournalSection jr={jr} last={lastEq} />
      </Section>

      <Section tag="info" title="Regime & notices" count={warnings.length} open={false} hint="SPY month-end closes and data warnings">
        {regime && (
          <p>
            {regime.reason ?? `SPY month-end ${regime.monthEnd}: ${num(regime.close)} vs ${cfg.regime_sma_months}-month SMA ${num(regime.sma)}.`}
            {regime.prior != null && ` Prior month-end ${regime.prior ? "risk-on" : "risk-off"}; ${regime.prior ? `stays risk-on unless SPY closes below ${num((regime.sma ?? 0) * (1 - (regime.band ?? 0)))} (SMA − ${pct(regime.band, 0, 100)})` : "turns risk-on at the SMA"}.`}
            <br /><span className="muted">Month-end closes: {regime.months.map((m) => `${m.month} ${num(m.close)}`).join(" · ")}</span>
          </p>
        )}
        {warnings.map((w) => <div key={w} className="notice">{w}</div>)}
        <p className="muted">
          Monthly momentum rotation: rank liquid large caps by 12-1 month momentum and closeness to the 52-week high, hold the top N
          while SPY is above its 10-month average. Equity E (risk cap) {money(cfg.E, 0)}.
        </p>
      </Section>

      <Section tag="info" title="Universe filters" count={funnel.at(-1)?.count ?? 0} open={false} hint="How many stocks pass each filter">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Step</th><th>Remaining</th></tr></thead>
            <tbody>{funnel.map((f, i) => <tr key={i}><td>{i + 1}. {f.step}</td><td>{f.count}</td></tr>)}</tbody>
          </table>
        </div>
      </Section>

      <Section tag="info" title="Data flags" count={blocking.length + review.length} open={false}
        hint={`${blocking.length} blocking, ${review.length} to review`}>
        <p className="muted">
          Blocking flags keep a stock out of signals until you clear them. Big moves are often real news (earnings, trial results):
          check the chart and clear the ones that aren&apos;t data errors. News sweep: {news.count ?? 0} of the last 90 days scanned.
        </p>
        <FlagTable flags={[...blocking, ...review]} />
      </Section>

      <Section tag="info" title="Order history" count={done.length} open={false} hint="Recently filled, dropped or cancelled buy tickets">
        {done.length
          ? <ul>{done.map((t) => <li key={t.id}>{t.ticker} · {t.status} · {t.signal_date} {t.kind}{t.note ? ` · ${t.note}` : ""}</li>)}</ul>
          : <p className="muted">None yet.</p>}
      </Section>

      <Section tag="info" title="Earnings calendar" count={(upcoming ?? []).length} open={false}
        hint={earningsSync ? `Finnhub, synced ${earningsSync.synced_at.slice(0, 10)} through ${earningsSync.to} · ${earnings.count ?? 0} dates` : `${earnings.count ?? 0} dates · Finnhub not synced yet`}>
        <p className="muted">
          Pulled from Finnhub every trading morning (the next ~13 weeks for the whole market) and used for the {cfg.earnings_blackout_days}-day
          earnings blackout on buys, covered-call expirations, each position&apos;s next earnings date and the screener&apos;s earnings filters.
          {!process.env.FINNHUB_API_KEY && <> <b>Add FINNHUB_API_KEY in Vercel</b> (free key from finnhub.io) to turn it on.</>}
        </p>
        <h3>Upcoming for your positions and orders</h3>
        {(upcoming ?? []).length ? (
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table>
              <thead><tr><th>Ticker</th><th>Report date</th><th>When</th><th>EPS estimate</th><th>Source</th></tr></thead>
              <tbody>
                {(upcoming ?? []).map((e) => (
                  <tr key={`${e.ticker}|${e.report_date}`}>
                    <td><StatusTag s={status.get(e.ticker)} /> <b>{e.ticker}</b></td>
                    <td>{e.report_date}</td>
                    <td>{e.hour ?? "—"}</td>
                    <td>{e.eps_estimate != null ? num(e.eps_estimate) : "—"}</td>
                    <td className="muted">{e.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No upcoming reports for stocks you hold or are buying.</p>}
        <p className="muted">Backup: upload a CSV from your broker with a ticker (or symbol) column and a report date column. It replaces earlier CSV uploads and is kept alongside the Finnhub dates.</p>
        <form action={uploadEarnings} className="row">
          <input type="file" name="file" accept=".csv,text/csv" />
          <button type="submit">Upload</button>
        </form>
      </Section>

      <Section tag="info" title="Strategy settings" open={false} hint="Buying power, limits and every rule parameter">
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
                  ) : Array.isArray(MOM_CHOICES[f.key]) ? (
                    <label key={f.key}>{f.label}
                      <select name={f.key} defaultValue={String(cfg[f.key])}>
                        {(MOM_CHOICES[f.key] as readonly string[]).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </label>
                  ) : (
                    <label key={f.key}>{f.label}<input name={f.key} inputMode={MOM_CHOICES[f.key] ? "text" : "decimal"} defaultValue={String(cfg[f.key])} /></label>
                  ),
                )}
              </div>
            </fieldset>
          ))}
          <button type="submit">Save settings</button>
        </form>
      </Section>
    </main>
  );
}

type Tag = "sell" | "buy" | "call" | "hold" | "watch" | "info";
const TAG_TEXT: Record<Tag, string> = { sell: "SELL", buy: "BUY", call: "CALL", hold: "HOLD", watch: "WATCH", info: "INFO" };

function Section({ id, tag, title, count, hint, open, children }: {
  id?: string; tag: Tag; title: string; count?: number; hint?: string; open: boolean; children: React.ReactNode;
}) {
  return (
    <details id={id} className={`msec msec-${tag}`} open={open}>
      <summary>
        <span className={`tag tag-${tag}`}>{TAG_TEXT[tag]}</span>
        <b>{title}</b>
        {count != null && <span className="pill">{count}</span>}
        {hint && <span className="muted msec-hint">{hint}</span>}
      </summary>
      <div className="msec-body">{children}</div>
    </details>
  );
}

type Status = "sell" | "buy" | "held" | "alternate" | "watch";
function StatusTag({ s }: { s?: Status }) {
  if (!s) return <span className="muted">—</span>;
  const m: Record<Status, [Tag, string]> = {
    sell: ["sell", "SELLING"], buy: ["buy", "BUY TODAY"], held: ["hold", "HELD"], alternate: ["watch", "ALTERNATE"], watch: ["watch", "WATCH"],
  };
  const [t, label] = m[s];
  return <span className={`tag tag-${t}`}>{label}</span>;
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

async function buildPlan(t: string, cfg: Awaited<ReturnType<typeof getMomConfig>>, riskOn: boolean | null, m: number): Promise<Plan> {
  const [{ data: cands }, cal] = await Promise.all([
    db().from("ss_mom_snapshots").select("ticker, comp_rank, close, sigma63, atr20, entry_ok")
      .eq("signal_date", t).eq("entry_ok", true).order("comp_rank").limit(1000),
    loadCalendar(),
  ]);
  // Earnings blackout: reports in the next N trading days after the signal date.
  const until = addTradingDays(cal, t, cfg.earnings_blackout_days);
  const { data: rep } = await db().from("ss_earnings_calendar").select("ticker").gt("report_date", t).lte("report_date", until);
  const candidates: Candidate[] = await withSectors((cands ?? []) as Omit<Candidate, "sector">[]);
  const wash = washBlocked(await closedLots(), t, cfg.wash_sale_block_days);
  return planPortfolio({ cfg, candidates, riskOn, earnings: new Set((rep ?? []).map((r) => r.ticker)), washBlocked: new Set(wash.keys()), scale: m });
}

function PlanSection({ plan, kind, signalDate, chase, budget, basis }: { plan: Plan; kind?: string; signalDate?: string; chase: number; budget: number; basis: string }) {
  const total = plan.buys.reduce((a, b) => a + b.amount, 0);
  return (
    <>
      <p className="muted">
        {kind === "monthly" || kind === "weekly"
          ? `Buy list from the ${kind} signals of ${signalDate}; these are already the orders under Buy today.`
          : `Not orders. ${signalDate} isn't a rebalance date, so nothing is bought; this is what a rebalance on its close would buy.`}
        {" "}Sized at the chase cap (S × {num(1 + chase, 2)}), the most a ticket may pay; the 9:45 ticket recomputes shares at the real limit.
        {" "}{plan.buys.length} of {plan.openSlots} open slots · {money(total, 0)} of {money(plan.I, 0)} investable.
      </p>
      {plan.message && <div className="notice">{plan.message}</div>}
      <p className="muted">
        <b>Shares by target</b> = the position&apos;s dollar target T ÷ the cap price (how many shares its share of the portfolio buys).{" "}
        <b>Shares by risk limit</b> = your risk budget per position ({basis} = {money(budget, 0)}) ÷ the stop distance D (the most shares
        you can hold so a stop-out loses no more than that). You buy the <b>smaller</b> of the two.
      </p>
      {plan.buys.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Ticker</th><th>Rank</th><th>Sector</th><th>σ63</th><th>Weight</th><th>Target T</th><th>Signal S</th><th>Cap</th><th>Stop dist. D</th><th title="Target T ÷ cap price: how many shares the dollar target buys">Shares by target</th><th title="Risk budget per position ÷ stop distance D: the most shares you can hold so a stop-out loses no more than the budget">Shares by risk limit</th><th title="The smaller of the two">Shares</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {plan.buys.map((b) => (
                <tr key={b.ticker}>
                  <td><Link href={`/t/${b.ticker}`}><b>{b.ticker}</b></Link></td>
                  <td>{b.comp_rank}</td>
                  <td>{sectorLabel(b.sector)}</td>
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
      {plan.skipped.length > 0 && (
        <details className="panel">
          <summary>Skipped ({plan.skipped.length})</summary>
          <ul>{plan.skipped.map((k) => <li key={k.ticker}>{k.ticker} (#{k.comp_rank}): {k.reason}</li>)}</ul>
        </details>
      )}
    </>
  );
}

function TicketsSection({ open, cfg }: { open: Ticket[]; cfg: Awaited<ReturnType<typeof getMomConfig>> }) {
  const tradeDay = open[0]?.trade_date;
  const chrome =
    `At 9:45 AM ET, open my brokerage account and look up the current bid and ask for these tickers: ${open.map((t) => t.ticker).join(", ")}. ` +
    `Then open the Momentum tab of my stock screener, find the "Buy today" section and, for each ticker, type the bid into its Bid box and the ask into its Ask box ` +
    `(the boxes are labelled "<TICKER> bid" and "<TICKER> ask"). Click "Calculate limits" and read me back each ticker's LP1, LP2 and shares. Do not place any orders.`;
  return (
    <>
      {!open.length ? (
        <p className="muted">No buy orders today. They are created the morning after a week-end or month-end signal (6:15am ET) while the regime is risk-on and slots are free.</p>
      ) : (
        <>
          <p><b>Buy orders for {tradeDay}</b></p>
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
                      <td><span className="tag tag-buy">BUY</span> <Link href={`/t/${t.ticker}`}><b>{t.ticker}</b></Link><input type="hidden" name="id" value={t.id} /> <AddLink ticker={t.ticker} />
                        {t.earnings_unchecked && <span className="tag tag-sell" title="Not screened for earnings: check the report date before buying" style={{ marginLeft: 4 }}>EARNINGS UNCHECKED</span>}</td>
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

          <h3>Record fills (after your broker fills the buy)</h3>
          <div className="card-list">
            {open.map((t) => (
              <div key={t.id} className="row panel">
                <span className="tag tag-buy">BUY</span><b style={{ minWidth: 60 }}>{t.ticker}</b>
                {t.earnings_unchecked && <span className="tag tag-sell">EARNINGS UNCHECKED</span>}
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
    </>
  );
}

type LotView = {
  id: number; ticker: string; shares: number; fill_price: number; filled_at: string; d: number; stop0: number; stop: number;
  highest_close: number | null; disaster_stop: number; disaster_posted: number | null; lt_date: string; earnings_date: string | null;
  ticket_id: number | null; rule_broken: boolean; rule_note: string | null;
  d_trail: number | null; wash_sale: boolean | null; lt_deferred_trigger: number | null; lt_deferred_reason: string | null;
};
type SellTicket = {
  id: number; ticker: string; exit_trigger: number; shares_to_sell: number; urgent: boolean; deadline: string | null; trade_date: string;
  signal_date: string; bid: number | null; ask: number | null; xp1: number | null; xp2: number | null; note: string | null;
};

function ExitSection({ sells, callTickers }: { sells: SellTicket[]; callTickers: Set<string> }) {
  if (!sells.length) return <p className="muted">Nothing to sell today. Every position stays above its stop.</p>;
  const chrome =
    `At 9:45 AM ET, open my brokerage account and look up the current bid and ask for: ${sells.map((t) => t.ticker).join(", ")}. ` +
    `Then open the Momentum tab of my stock screener, find the "Sell today" section, type each bid and ask into the boxes labelled "<TICKER> exit bid" / "<TICKER> exit ask", ` +
    `click "Calculate exit limits" and read me back XP1 and XP2 for each. Do not place any orders.`;
  return (
    <>
      <p><b>Sell orders for {sells[0].trade_date}</b></p>
      <p className="muted">
        Sells go first at 9:45 ET: limit at XP1; after 10 minutes move to XP2 (the bid); after another 20 minutes sell at market.
        Stop, regime, acquisition and halt exits must be out the same session, even if the stock gaps below the stop.
      </p>
      <form action={quoteExits}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ticker</th><th>Why</th><th>Shares</th><th>Out by</th><th>Bid</th><th>Ask</th><th>XP1</th><th>XP2</th><th style={{ textAlign: "left" }}>Detail</th></tr></thead>
            <tbody>
              {sells.map((t) => (
                <tr key={t.id}>
                  <td><span className="tag tag-sell">SELL</span> <Link href={`/t/${t.ticker}`}><b>{t.ticker}</b></Link><input type="hidden" name="id" value={t.id} /></td>
                  <td className={t.urgent ? "down" : ""}>{t.exit_trigger}. {TRIGGER_LABEL[t.exit_trigger]}</td>
                  <td>{t.shares_to_sell}</td>
                  <td>{t.urgent && t.exit_trigger !== 4 ? "Same day" : t.deadline}</td>
                  <td><input name={`bid_${t.id}`} aria-label={`${t.ticker} exit bid`} inputMode="decimal" defaultValue={t.bid ?? ""} style={{ width: 84 }} /></td>
                  <td><input name={`ask_${t.id}`} aria-label={`${t.ticker} exit ask`} inputMode="decimal" defaultValue={t.ask ?? ""} style={{ width: 84 }} /></td>
                  <td className="score">{t.xp1 != null ? num(t.xp1) : "—"}</td>
                  <td>{t.xp2 != null ? num(t.xp2) : "—"}</td>
                  <td style={{ textAlign: "left", whiteSpace: "normal", minWidth: 220 }}>{t.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="submit" style={{ marginTop: 8 }}>Calculate exit limits</button>
      </form>
      <h3>Record exits (after your broker fills the sell)</h3>
      <div className="card-list">
        {sells.map((t) => (
          <form key={t.id} action={exitTicket} className="row panel">
            <span className="tag tag-sell">SELL</span><b style={{ minWidth: 60 }}>{t.ticker}</b>
            <input type="hidden" name="id" value={t.id} />
            <label>Avg exit X<input name="price" inputMode="decimal" style={{ width: 90 }} /></label>
            <label>Fees $<input name="fees" inputMode="decimal" defaultValue="0" style={{ width: 70 }} /></label>
            {callTickers.has(t.ticker) && <label>Call buy-back $/sh<input name="call_price" inputMode="decimal" style={{ width: 90 }} /></label>}
            <label>Time (NY)<input type="datetime-local" name="exited_at" /></label>
            <button type="submit" style={{ alignSelf: "flex-end" }}>Sold {t.shares_to_sell}</button>
          </form>
        ))}
      </div>
      <details className="panel" style={{ marginTop: 12 }}>
        <summary>Claude in Chrome prompt for exits</summary>
        <textarea readOnly value={chrome} rows={4} style={{ width: "100%", marginTop: 8 }} />
      </details>
    </>
  );
}

function PositionsSection({ lots, lastClose }: { lots: LotView[]; lastClose: Map<string, number> }) {
  if (!lots.length) return <p className="muted">No positions yet. Recorded buy fills and stocks you add above show up here with their stops.</p>;
  // Any day: the disaster stop moved ≥ 2% above what's posted at the broker (or nothing is posted).
  const stale = lots.filter(gtcNeedsUpdate);
  return (
    <>
      {stale.length > 0 && (
        <div className="notice">
          {stale.map((l) => <div key={l.id}>Update GTC stop <b>{l.ticker}</b> → {num(l.disaster_stop)}{l.disaster_posted != null ? ` (posted ${num(l.disaster_posted)})` : " (none posted)"}</div>)}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Ticker</th><th>Entry</th><th>Shares</th><th>F</th><th title="Entry stop distance (initial risk)">D</th><th title="Today's trailing distance D_t">D trail</th><th>Stop0</th><th>High close</th><th>Stop</th><th>Disaster</th><th>At broker</th><th>Close</th><th>P&amp;L</th><th>R</th><th>Earnings</th><th>LT date</th><th></th></tr>
          </thead>
          <tbody>
            {lots.map((l) => {
              const c = lastClose.get(l.ticker);
              const pnl = c != null ? (c - l.fill_price) * l.shares : null;
              return (
                <tr key={l.id}>
                  <td>
                    <span className="tag tag-hold">HOLD</span> <Link href={`/t/${l.ticker}`}><b>{l.ticker}</b></Link>
                    {l.rule_broken && <span className="tag tag-watch" title={l.rule_note ?? ""} style={{ marginLeft: 4 }}>RULE BREAK</span>}
                    {l.wash_sale && <span className="tag tag-watch" title="Bought within 30 days of a loss sale" style={{ marginLeft: 4 }}>WASH SALE</span>}
                    {l.lt_deferred_trigger != null && <div className="muted" title={l.lt_deferred_reason ?? ""}>{TRIGGER_LABEL[l.lt_deferred_trigger]}: deferred for LT until {l.lt_date}</div>}
                  </td>
                  <td>{l.filled_at.slice(0, 10)}</td>
                  <td>{l.shares}</td>
                  <td>{num(l.fill_price)}</td>
                  <td>{num(l.d)}</td>
                  <td>{num(l.d_trail ?? l.d)}</td>
                  <td>{num(l.stop0)}</td>
                  <td>{num(l.highest_close)}</td>
                  <td className="score">{num(l.stop)}</td>
                  <td>{num(l.disaster_stop)}</td>
                  <td className={l.disaster_posted != null && Math.abs(l.disaster_posted - l.disaster_stop) <= 0.004 ? "up" : "down"}>{l.disaster_posted != null ? num(l.disaster_posted) : "not set"}</td>
                  <td>{num(c)}</td>
                  <td className={pnl != null && pnl < 0 ? "down" : "up"}>{money(pnl)}</td>
                  <td>{c != null ? num((c - l.fill_price) / l.d) : "—"}</td>
                  <td>{l.earnings_date ?? "—"}</td>
                  <td>{l.lt_date}</td>
                  <td><Link href={`/momentum?add=${l.ticker}#hold`} className="btn ghost">+ Add shares</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {stale.length > 0 && (
        <form action={markDisasterPosted} style={{ marginTop: 8 }}>
          {stale.map((l) => <input key={l.id} type="hidden" name="lot" value={l.id} />)}
          <button type="submit" className="ghost">I&apos;ve placed these disaster stops at the broker</button>
        </form>
      )}
    </>
  );
}

function AddLink({ ticker, held }: { ticker: string; held?: boolean }) {
  return <Link href={`/momentum?add=${ticker}#hold`} className="btn ghost" style={{ padding: "4px 10px" }}>{held ? "+ Add shares" : "+ Add"}</Link>;
}

function AddedNotice({ lot }: { lot: LotView }) {
  return (
    <div className="notice row spread">
      <span>
        Added <b>{lot.ticker}</b>: {lot.shares} sh at {num(lot.fill_price)} · stop {num(lot.stop)} · disaster {num(lot.disaster_stop)}.
        {lot.rule_broken ? <> <span className="tag tag-watch">RULE BREAK</span> {lot.rule_note}</> : " Fits the strategy's rules."}
      </span>
      {lot.ticket_id == null && (
        <form action={undoLot}><input type="hidden" name="id" value={lot.id} /><button type="submit" className="danger">Undo</button></form>
      )}
    </div>
  );
}

/** One form for both: record a stock you bought, or add shares to a holding. "Check" re-runs the rules; "Add" saves. */
function AddForm({ preview }: { preview: ManualPreview | null }) {
  return (
    <details className="panel" open={!!preview} style={{ marginBottom: 12 }}>
      <summary><b>{preview?.ticket ? `+ Add ${preview.ticker} (today's buy order)` : preview?.holding ? `+ Add shares to ${preview.ticker}` : preview ? `+ Add ${preview.ticker} to positions` : "+ Add a stock you bought"}</b></summary>
      <form method="get" action="/momentum#hold" className="row" style={{ marginTop: 8, alignItems: "flex-end" }}>
        <label>Ticker<input name="add" defaultValue={preview?.ticker ?? ""} style={{ width: 90, textTransform: "uppercase" }} required /></label>
        <label>Avg price<input name="price" inputMode="decimal" defaultValue={preview?.price != null ? preview.price.toFixed(2) : ""} style={{ width: 90 }} /></label>
        <label>Shares<input name="shares" inputMode="decimal" defaultValue={preview?.shares ?? ""} style={{ width: 80 }} /></label>
        <label>Time (NY)<input type="datetime-local" name="filled_at" /></label>
        <button type="submit" className="ghost">Check rules</button>
        {preview && !preview.error && <button type="submit" formAction={addPosition} formMethod="post">{preview.ticket ? "Record fill" : preview.holding ? "Add shares" : "Add to positions"}</button>}
      </form>
      {preview?.error && <div className="notice">{preview.error}</div>}
      {preview && !preview.error && (
        <div style={{ marginTop: 8 }}>
          <p className="muted">
            {preview.name ?? preview.ticker} · last close {num(preview.close)} · stop distance D {num(preview.D)} → stop {preview.price != null && preview.D != null ? num(preview.price - preview.D) : "—"}
            {preview.target != null && <> · target {money(preview.target, 0)}{preview.holding ? `, you hold ${money(preview.valueBefore, 0)}` : ""}</>}
            {preview.suggestedShares != null && <> · suggested {preview.suggestedShares} sh</>}
          </p>
          {preview.ticket ? (
            <p className="up">This is today&apos;s buy order: saving records its fill and closes the order{preview.ticket.lp1 == null ? ` (limit cap ${num(preview.ticket.cap)})` : ` (LP1 ${num(preview.ticket.lp1)})`}.</p>
          ) : preview.shares == null ? (
            <p className="muted">Enter the shares to check the rules.</p>
          ) : preview.warnings.length ? (
            <div className="notice">
              <b><span className="tag tag-watch">RULE BREAK</span> You can still add it; it will be tracked and marked as a rule break:</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          ) : (
            <p className="up">Fits the strategy&apos;s rules.</p>
          )}
        </div>
      )}
    </details>
  );
}

type CallView = { id: number; ticker: string; contract: string; expiration: string; strike: number; contracts: number; premium: number; status: string; note: string | null };
type IdeaView = { ticker: string; contracts: number; exp_earliest: string | null; exp_latest: string | null; note: string | null; as_of: string };

function CallsSection({ ideas, calls, lastClose, cfg }: { ideas: IdeaView[]; calls: CallView[]; lastClose: Map<string, number>; cfg: Awaited<ReturnType<typeof getMomConfig>> }) {
  const pending = calls.filter((c) => c.status === "assign_pending");
  const open = calls.filter((c) => c.status === "open");
  return (
    <>
      <p className="muted">
        Only on positions that already hold 100+ shares. In Robinhood, pick a call far out of the money (delta about {cfg.call_delta_min}–{cfg.call_delta_max})
        that expires inside the window shown (before the next month-end rebalance and before earnings), sell it, then record it here.
        If a call finishes in the money, the shares are called away and count as an exit at the strike.
      </p>
      {pending.map((c) => (
        <div key={c.id} className="notice row spread">
          <span><span className="tag tag-sell">CALLED AWAY?</span> <b>{c.ticker}</b> {c.contracts * 100} sh at {num(c.strike)} · {c.note}</span>
          <span className="row">
            <form action={assignCall}><input type="hidden" name="id" value={c.id} /><button type="submit">Confirm: shares were called away</button></form>
            <form action={expireCall}><input type="hidden" name="id" value={c.id} /><button type="submit" className="ghost">No, it expired</button></form>
          </span>
        </div>
      ))}

      <h3><span className="tag tag-call">SELL TO OPEN</span> Positions you can sell a call on</h3>
      {!ideas.length ? (
        <p className="muted">No position has an uncovered round lot of 100 shares right now.</p>
      ) : (
        <div className="card-list">
          {ideas.map((i) => (
            <div key={i.ticker} className="panel">
              <div>
                <span className="tag tag-call">CALL</span> <b>{i.ticker}</b> · {i.contracts} contract{i.contracts === 1 ? "" : "s"} ({i.contracts * 100} sh) · last {num(lastClose.get(i.ticker))}
                {i.exp_latest
                  ? <> · expire between <b>{i.exp_earliest}</b> and <b>{i.exp_latest}</b> · delta {cfg.call_delta_min}–{cfg.call_delta_max}</>
                  : null}
                {" "}<a href={`https://robinhood.com/options/chains/${i.ticker}`} target="_blank" rel="noreferrer">Open chain in Robinhood ↗</a>
              </div>
              {i.note && <p className="muted" style={{ margin: "6px 0" }}>{i.note}</p>}
              {i.exp_latest && (
                <form action={sellCall} className="row" style={{ alignItems: "flex-end", marginTop: 6 }}>
                  <input type="hidden" name="ticker" value={i.ticker} />
                  <label>Expiration<input type="date" name="expiration" min={i.exp_earliest ?? undefined} defaultValue={i.exp_latest} /></label>
                  <label>Strike<input name="strike" inputMode="decimal" style={{ width: 80 }} /></label>
                  <label>Contracts<input name="contracts" inputMode="numeric" defaultValue={i.contracts} style={{ width: 70 }} /></label>
                  <label>Premium $/sh<input name="premium" inputMode="decimal" style={{ width: 90 }} /></label>
                  <label>Time (NY)<input type="datetime-local" name="opened_at" /></label>
                  <button type="submit">I sold this call</button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}

      <h3><span className="tag tag-hold">OPEN</span> Calls you&apos;ve sold</h3>
      {!open.length ? <p className="muted">None open.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ticker</th><th>Contracts</th><th>Strike</th><th>Expires</th><th>Premium</th><th>Stock</th><th style={{ textAlign: "left" }}>Note</th><th></th></tr></thead>
            <tbody>
              {open.map((c) => {
                const px = lastClose.get(c.ticker);
                const itm = px != null && px >= c.strike;
                return (
                  <tr key={c.id}>
                    <td><span className="tag tag-call">CALL</span> <b>{c.ticker}</b></td>
                    <td>{c.contracts}</td>
                    <td>{num(c.strike)}</td>
                    <td>{c.expiration}</td>
                    <td>{money(c.premium * 100 * c.contracts, 0)}</td>
                    <td className={itm ? "down" : ""}>{num(px)}{itm ? " · in the money" : ""}</td>
                    <td style={{ textAlign: "left", whiteSpace: "normal", minWidth: 180 }} className="muted">{c.note}</td>
                    <td>
                      <form action={buyBackCall} className="row">
                        <input type="hidden" name="id" value={c.id} />
                        <input name="price" inputMode="decimal" placeholder="$/sh" aria-label={`${c.ticker} call buy-back price`} style={{ width: 70 }} />
                        <button type="submit" className="ghost">Bought back</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const SERIES = [
  { key: "after_tax_value", label: "Strategy (after tax)", color: "#3987e5" },
  { key: "spy_value", label: "SPY", color: "#d95926" },
  { key: "mtum_value", label: "MTUM", color: "#199e70" },
] as const;

/** Equity curve: strategy after tax vs SPY and MTUM from the same start (one axis, dollars). */
function EquityChart({ rows }: { rows: EquityRow[] }) {
  const W = 720, H = 220, L = 56, R = 110, T = 10, B = 24;
  const vals = rows.flatMap((r) => SERIES.map((s) => r[s.key]).filter((v): v is number => v != null));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.05 || hi * 0.01 || 1;
  const y0 = lo - pad, y1 = hi + pad;
  const x = (i: number) => L + (rows.length > 1 ? (i / (rows.length - 1)) * (W - L - R) : 0);
  const y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const ticks = [0, 1, 2, 3].map((k) => y0 + ((y1 - y0) * k) / 3);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Equity curve: strategy after tax vs SPY and MTUM" style={{ width: "100%", maxWidth: W, height: "auto" }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
          <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{money(v, 0)}</text>
        </g>
      ))}
      <text x={L} y={H - 6} fontSize={11} fill="var(--muted)">{rows[0].d}</text>
      <text x={W - R} y={H - 6} fontSize={11} fill="var(--muted)" textAnchor="end">{rows.at(-1)!.d}</text>
      {SERIES.map((s) => {
        const pts = rows.map((r, i) => (r[s.key] != null ? `${x(i)},${y(r[s.key] as number)}` : null)).filter(Boolean);
        const last = [...rows].reverse().find((r) => r[s.key] != null);
        return (
          <g key={s.key}>
            <polyline points={pts.join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            {last && <text x={W - R + 6} y={y(last[s.key] as number) + 4} fontSize={11} fill="var(--text)">{s.label}</text>}
          </g>
        );
      })}
      {/* Hover: one hit column per day with every value. */}
      {rows.map((r, i) => (
        <rect key={r.d} x={x(i) - (W - L - R) / Math.max(rows.length, 1) / 2} y={T} width={(W - L - R) / Math.max(rows.length, 1)} height={H - T - B} fill="transparent">
          <title>{`${r.d}\n${SERIES.map((s) => `${s.label}: ${r[s.key] != null ? money(r[s.key] as number, 0) : "—"}`).join("\n")}`}</title>
        </rect>
      ))}
    </svg>
  );
}

function JournalSection({ jr, last }: { jr: Awaited<ReturnType<typeof journal>>; last: EquityRow | undefined }) {
  if (!jr.rows.length) return <p className="muted">The journal starts with the first nightly run after this release.</p>;
  const r = jr.returns, s = jr.stats;
  return (
    <>
      <div className="row" style={{ gap: 16, flexWrap: "wrap", margin: "4px 0 8px" }}>
        {SERIES.map((x) => <span key={x.key}><span style={{ display: "inline-block", width: 14, height: 2, background: x.color, verticalAlign: "middle", marginRight: 6 }} />{x.label}</span>)}
      </div>
      {jr.rows.length > 1 ? <EquityChart rows={jr.rows} /> : <p className="muted">One night recorded so far; the curve appears from the second.</p>}
      <div className="grid" style={{ margin: "12px 0" }}>
        <div className="stat"><div className="k">After-tax return 3 / 6 / 12 mo</div><div className="v">{pct(r.m3, 1, 100)} · {pct(r.m6, 1, 100)} · {pct(r.m12, 1, 100)}</div></div>
        <div className="stat"><div className="k">SPY · MTUM 12 mo</div><div className="v">{pct(r.spy12, 1, 100)} · {pct(r.mtum12, 1, 100)}</div></div>
        <div className="stat"><div className="k">Turnover (12 mo)</div><div className="v">{s.turnover12m != null ? `${num(s.turnover12m, 2)}×` : "—"}</div></div>
        <div className="stat"><div className="k">Win rate · avg R · avg days</div><div className="v">{pct(s.winRate, 0, 100)} · {num(s.avgR, 2)} · {num(s.avgDaysHeld, 0)}</div></div>
      </div>
      {last && (
        <p className="muted">
          {last.d}: value {money(last.strategy_value, 0)} (open {money(last.open_value, 0)} + realized {money(last.realized, 0)} + cash {money(last.cash, 0)}),
          after tax {money(last.after_tax_value, 0)}. Realized YTD: ST {money(last.realized_st_ytd, 0)}, LT {money(last.realized_lt_ytd, 0)}. {s.trades} closed lots.
        </p>
      )}
      <details className="panel">
        <summary>Table</summary>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Strategy</th><th>After tax</th><th>SPY</th><th>MTUM</th><th>m</th></tr></thead>
            <tbody>{[...jr.rows].reverse().slice(0, 60).map((x) => (
              <tr key={x.d}><td>{x.d}</td><td>{money(x.strategy_value, 0)}</td><td>{money(x.after_tax_value, 0)}</td><td>{money(x.spy_value, 0)}</td><td>{money(x.mtum_value, 0)}</td><td>{num(x.vol_scale, 2)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </>
  );
}
