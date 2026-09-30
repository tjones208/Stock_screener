-- Earnings calendar from Finnhub (nightly) alongside broker CSV uploads. The screener's
-- next_earnings_date now comes from this calendar, and earnings_covered_until says how far ahead
-- it is complete (no date inside that window = nothing scheduled, not "unknown").
alter table public.ss_earnings_calendar add column if not exists hour text;          -- before open | after close | during market
alter table public.ss_earnings_calendar add column if not exists eps_estimate real;
alter table public.ss_earnings_calendar add column if not exists source text not null default 'csv';  -- finnhub | csv
create index if not exists ss_earnings_calendar_date_idx on public.ss_earnings_calendar (report_date);

drop view if exists public.ss_screener;
create view public.ss_screener
with (security_invoker = true) as
select t.ticker, t.name, t.type, t.exchange, t.sector, t.industry, t.market_cap,
       t.in_sp500,
       i.as_of, i.close, i.change_pct, i.gap_pct, i.volume, i.avg_vol20, i.vol_ratio,
       i.sma20, i.sma50, i.sma200, i.sma50_prev, i.sma200_prev, i.ema9, i.ema21,
       i.rsi14, i.atr14, i.hv30, i.high_52w, i.low_52w, i.pct_from_high, i.pct_from_low,
       f.pe, f.ps, f.pb, f.eps_ttm, f.revenue_ttm, f.revenue_growth_yoy,
       f.gross_margin, f.operating_margin, f.net_margin, f.roe, f.debt_to_equity,
       f.current_ratio, f.free_cash_flow_ttm, f.dividend_yield,
       coalesce(
         (select min(e.report_date) from ss_earnings_calendar e where e.ticker = t.ticker and e.report_date >= i.as_of),
         f.next_earnings_date
       ) as next_earnings_date,
       (select (s.value->>'to')::date from ss_settings s where s.key = 'earnings_sync') as earnings_covered_until,
       i.vwap, i.range_pos, i.change_5d, i.change_20d, i.nr7, i.inside_day,
       i.day_open, i.day_high, i.day_low,
       i.sma10, i.prev_open, i.prev_close,
       i.ema20, i.ema20_5d, i.swing_low5, i.swing_high20, i.resistance60,
       i.rsi_min5
from ss_tickers t
join ss_indicators i on i.ticker = t.ticker
left join ss_fundamentals f on f.ticker = t.ticker;
