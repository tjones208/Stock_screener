-- Remove Alpaca / the wheel: no more option data. The screener view loses its put columns, the
-- nightly options scan becomes an alerts-only job, and covered calls are recorded by hand.

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
       f.current_ratio, f.free_cash_flow_ttm, f.dividend_yield, f.next_earnings_date,
       i.vwap, i.range_pos, i.change_5d, i.change_20d, i.nr7, i.inside_day,
       i.day_open, i.day_high, i.day_low,
       i.sma10, i.prev_open, i.prev_close,
       i.ema20, i.ema20_5d, i.swing_low5, i.swing_high20, i.resistance60,
       i.rsi_min5
from ss_tickers t
join ss_indicators i on i.ticker = t.ticker
left join ss_fundamentals f on f.ticker = t.ticker;

drop table if exists public.ss_option_candidates;
alter table public.ss_tickers drop column if exists has_options;
delete from public.ss_alert_rules where kind = 'wheel_yield';

-- The 10:25 UTC job now only evaluates alerts.
select cron.unschedule('ss-options') where exists (select 1 from cron.job where jobname = 'ss-options');
select cron.schedule('ss-alerts', '25 10 * * 2-6', $$select public.ss_call_app('/api/cron/alerts', 120000)$$);

-- Covered-call eligibility (no quotes): uncovered round lots and the expiration range that fits.
drop table if exists public.ss_mom_call_ideas;
create table public.ss_mom_call_ideas (
  ticker        text primary key,
  as_of         date not null,
  contracts     integer not null,
  exp_earliest  date,
  exp_latest    date,
  note          text,
  updated_at    timestamptz not null default now()
);
alter table public.ss_mom_call_ideas enable row level security;
