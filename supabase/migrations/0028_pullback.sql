-- Momentum pullback swing strategy (lib/pullback): logged trades, one saved scan per signal day,
-- two read functions for the scan, and the morning cron. Settings live in ss_settings (key "pullback").

-- Trades you log from the Pullback tab: open while exit_d is null.
create table if not exists public.ss_pb_trades (
  id           bigserial primary key,
  ticker       text not null,
  signal_d     date,                 -- scan that produced the buy, when bought from the list
  entry_d      date not null,
  entry        numeric not null,     -- your average fill
  shares       numeric not null,
  stop         numeric not null,
  target       numeric not null,
  exit_d       date,
  exit         numeric,
  exit_reason  text,                 -- stop | target | close_below_ma | time_stop | manual
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists ss_pb_trades_open_idx on public.ss_pb_trades (exit_d);

-- The scan for each signal day (latest close): buy list, exit list, regime and funnel.
create table if not exists public.ss_pb_scans (
  signal_d     date primary key,
  trade_d      date,                 -- the session the lists are for
  equity       numeric,
  regime       jsonb,
  funnel       jsonb,
  buys         jsonb not null default '[]',
  exits        jsonb not null default '[]',
  warnings     jsonb not null default '[]',
  created_at   timestamptz not null default now(),
  notified_at  timestamptz
);

alter table public.ss_pb_trades enable row level security;
alter table public.ss_pb_scans enable row level security;
revoke all on public.ss_pb_trades, public.ss_pb_scans from anon, authenticated;
revoke all on sequence public.ss_pb_trades_id_seq from anon, authenticated;

-- Per ticker with a bar on the latest trading day: bars in the window, close, the close
-- p_lookback sessions earlier, average dollar volume, and the mid / slow moving averages. Sessions
-- are the market ticker's last p_days bars; one pass over those days (the bars table is laid out by date).
create or replace function public.ss_pb_universe(p_days integer, p_lookback integer, p_dv_days integer, p_mid integer, p_slow integer, p_market text default 'SPY')
returns table (ticker text, type text, n integer, c real, c_lb real, adv double precision, ma_mid double precision, ma_slow double precision, flagged boolean)
language sql stable
as $$
  with days as (
    select d, row_number() over (order by d desc)::integer as k
    from (select d from ss_daily_bars where ticker = p_market order by d desc limit p_days) z
  ),
  agg as (
    select b.ticker, count(*)::integer as n,
           max(b.c) filter (where dd.k = 1) as c,
           max(b.c) filter (where dd.k = p_lookback + 1) as c_lb,
           case when count(*) filter (where dd.k <= p_dv_days) >= p_dv_days then avg(b.c::float8 * b.v) filter (where dd.k <= p_dv_days) end as adv,
           case when count(*) filter (where dd.k <= p_mid) >= p_mid then avg(b.c::float8) filter (where dd.k <= p_mid) end as ma_mid,
           case when count(*) filter (where dd.k <= p_slow) >= p_slow then avg(b.c::float8) filter (where dd.k <= p_slow) end as ma_slow
    from ss_daily_bars b join days dd on dd.d = b.d
    where b.d >= (select min(d) from days)
    group by b.ticker
    having count(*) filter (where dd.k = 1) = 1
  )
  select a.ticker, t.type, a.n, a.c, a.c_lb, a.adv, a.ma_mid, a.ma_slow,
         exists (select 1 from ss_data_flags f where f.ticker = a.ticker and not f.cleared and f.excludes) as flagged
  from agg a left join ss_tickers t on t.ticker = a.ticker
$$;

-- The last p_days sessions of bars for some tickers, oldest first, as arrays (one row per ticker).
create or replace function public.ss_pb_bars(p_tickers text[], p_days integer, p_market text default 'SPY')
returns table (ticker text, d date[], o real[], h real[], l real[], c real[], v double precision[])
language sql stable
as $$
  with first_d as (
    select min(d) as d from (select d from ss_daily_bars where ticker = p_market order by d desc limit p_days) z
  )
  select b.ticker, array_agg(b.d order by b.d), array_agg(b.o order by b.d), array_agg(b.h order by b.d),
         array_agg(b.l order by b.d), array_agg(b.c order by b.d), array_agg(b.v::float8 order by b.d)
  from ss_daily_bars b
  where b.ticker = any(p_tickers) and b.d >= (select d from first_d)
  group by b.ticker
$$;

revoke all on function public.ss_pb_universe(integer, integer, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.ss_pb_bars(text[], integer, text) from public, anon, authenticated;
grant execute on function public.ss_pb_universe(integer, integer, integer, integer, integer, text) to service_role;
grant execute on function public.ss_pb_bars(text[], integer, text) to service_role;

-- Tue–Sat 10:20 UTC, after the bars (10:05) and indicators (10:10): scan the latest close and push
-- the buys and exits for the next session (no push when there is nothing to do).
select cron.unschedule(jobid) from cron.job where jobname = 'ss-pullback';
select cron.schedule('ss-pullback', '20 10 * * 2-6', $$select public.ss_call_app('/api/cron/pullback', 120000)$$);
