import "server-only";
// Nightly equity journal row (ss_mom_equity) and the numbers the Momentum tab shows from it.
import { db, fetchAll } from "../db";
import type { MomConfig } from "./config";
import { equityRow, killSwitch, trailingReturn, tradeStats, type ClosedLotV, type EquityRow } from "./journal";

async function closeOn(ticker: string, t: string): Promise<number | null> {
  const { data } = await db().from("ss_daily_bars").select("c").eq("ticker", ticker).lte("d", t).order("d", { ascending: false }).limit(1);
  return (data?.[0]?.c as number | undefined) ?? null;
}

async function closedForJournal(): Promise<ClosedLotV[]> {
  return fetchAll<ClosedLotV>((a, b) => db().from("ss_mom_lots")
    .select("pnl, term, exit_date, exit_price, shares, r_multiple, days_held").not("exit_date", "is", null).range(a, b));
}

/** Write tonight's row: open lots at the close, realized P&L, cash = B − invested, SPY / MTUM from the same start. */
export async function writeEquity(t: string, cfg: MomConfig, m: number) {
  const [{ data: lots }, closed, spy, mtum, { data: first }] = await Promise.all([
    db().from("ss_mom_lots").select("ticker, shares, fill_price, lt_date").is("exit_date", null),
    closedForJournal(),
    closeOn("SPY", t), closeOn("MTUM", t),
    db().from("ss_mom_equity").select("d, strategy_value").lt("d", t).order("d").limit(1),
  ]);
  const tickers = [...new Set((lots ?? []).map((l) => l.ticker as string))];
  const { data: bars } = tickers.length
    ? await db().from("ss_daily_bars").select("ticker, c").eq("d", t).in("ticker", tickers)
    : { data: [] as { ticker: string; c: number }[] };
  const close = new Map((bars ?? []).map((b) => [b.ticker, b.c as number]));
  const start = first?.[0]
    ? { strategy_value: first[0].strategy_value as number, spy: await closeOn("SPY", first[0].d as string), mtum: await closeOn("MTUM", first[0].d as string) }
    : null;
  const row = equityRow({
    d: t, b: cfg.B, spy, mtum, m, first: start, cfg,
    open: (lots ?? []).map((l) => ({ shares: l.shares, fill_price: l.fill_price, lt_date: l.lt_date, close: close.get(l.ticker) ?? l.fill_price })),
    closed: closed.filter((l) => l.exit_date <= t),
  });
  const { error } = await db().from("ss_mom_equity").upsert(row, { onConflict: "d" });
  if (error) throw new Error(`ss_mom_equity: ${error.message}`);
  return { value: Math.round(row.strategy_value), afterTax: Math.round(row.after_tax_value) };
}

/** Everything the journal section and the month-end push need. */
export async function journal(t: string) {
  const [rows, closed] = await Promise.all([
    fetchAll<EquityRow>((a, b) => db().from("ss_mom_equity").select("*").order("d").range(a, b)),
    closedForJournal(),
  ]);
  return {
    rows,
    returns: {
      m3: trailingReturn(rows, 3, "after_tax_value"), m6: trailingReturn(rows, 6, "after_tax_value"), m12: trailingReturn(rows, 12, "after_tax_value"),
      spy12: trailingReturn(rows, 12, "spy_value"), mtum12: trailingReturn(rows, 12, "mtum_value"),
    },
    stats: tradeStats(closed, rows, t),
    kill: killSwitch(rows),
  };
}
