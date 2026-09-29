-- Momentum strategy (monthly rebalance), steps 1–3: data layer + validation, universe + signals,
-- regime inputs. All day counts are trading days (bar rows) unless a column says calendar days.

alter table public.ss_tickers add column if not exists composite_figi text;

-- Massive splits. Bars are split-adjusted as of the day they were fetched, so bars stored before a
-- split are re-fetched for that ticker ("repaired"); until then the ticker is flagged.
create table if not exists public.ss_splits (
  ticker          text not null,
  execution_date  date not null,
  split_from      numeric not null,
  split_to        numeric not null,
  -- True when bars dated before the split were fetched before it (so they are unadjusted).
  needs_repair    boolean not null default false,
  repaired_at     timestamptz,
  primary key (ticker, execution_date)
);

-- Validation flags. excludes = true blocks the ticker from signals until cleared by hand;
-- excludes = false is a manual-review note only.
create table if not exists public.ss_data_flags (
  ticker      text not null,
  kind        text not null,  -- missing_day | zero_volume | big_move | split_unrepaired | buyout_news | buyout_review
  d           date not null,  -- bar or article date the flag is about
  detail      text,
  excludes    boolean not null default true,
  cleared     boolean not null default false,
  cleared_at  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (ticker, kind, d)
);

-- Future market holidays (Massive /v1/marketstatus/upcoming). Past holidays are the empty loaded days.
create table if not exists public.ss_market_holidays (
  d       date primary key,
  name    text,
  status  text   -- closed | early-close
);

-- Earnings dates uploaded from a broker CSV (not in Massive's core stocks API).
create table if not exists public.ss_earnings_calendar (
  ticker       text not null,
  report_date  date not null,
  uploaded_at  timestamptz not null default now(),
  primary key (ticker, report_date)
);

-- Market-wide news sweep progress, one row per calendar day scanned for acquisition headlines.
create table if not exists public.ss_news_days (
  d           date primary key,
  articles    integer not null,
  matches     integer not null,
  fetched_at  timestamptz not null default now()
);

-- Full ranking snapshot per signal date (every universe stock).
create table if not exists public.ss_mom_snapshots (
  signal_date      date not null,
  ticker           text not null,
  close            real,
  market_cap       numeric,
  sic2             text,
  median_dv60      real,
  bars             integer,
  mom              real,
  h52              real,
  days_since_high  integer,
  mom_pct          real,
  h52_pct          real,
  composite        real,
  comp_rank        integer,
  sigma63          real,
  atr20            real,
  entry_ok         boolean,
  hold_ok          boolean,
  primary key (signal_date, ticker)
);
create index if not exists ss_mom_snapshots_rank_idx on public.ss_mom_snapshots (signal_date, comp_rank);

create table if not exists public.ss_mom_runs (
  signal_date  date not null,
  kind         text not null,   -- daily | weekly | monthly
  n            integer,
  funnel       jsonb,
  warnings     jsonb,
  regime       jsonb,
  created_at   timestamptz not null default now(),
  primary key (signal_date, kind)
);

alter table public.ss_splits enable row level security;
alter table public.ss_data_flags enable row level security;
alter table public.ss_market_holidays enable row level security;
alter table public.ss_earnings_calendar enable row level security;
alter table public.ss_news_days enable row level security;
alter table public.ss_mom_snapshots enable row level security;
alter table public.ss_mom_runs enable row level security;

-- Fundamentals (market cap, SIC, FIGI): momentum-liquid common stocks now queue ahead of the rest.
create or replace view public.ss_fundamentals_queue
with (security_invoker = true) as
select t.ticker,
       case when exists (select 1 from ss_watchlist_items w where w.ticker = t.ticker) then 0
            when t.type = 'CS' and i.close >= 10 and i.avg_vol20 * i.close >= 1e7 then 1
            when t.in_sp500 then 2
            else 3 end as priority,
       f.fetched_at
from ss_tickers t
join ss_indicators i on i.ticker = t.ticker
left join ss_fundamentals f on f.ticker = t.ticker
where t.active
  and t.type in ('CS', 'ADRC')
  and (i.close < 50
       or (t.type = 'CS' and i.close >= 10 and i.avg_vol20 * i.close >= 1e7)
       or exists (select 1 from ss_watchlist_items w where w.ticker = t.ticker))
  and (f.fetched_at is null or f.fetched_at < now() - interval '30 days')
order by priority, f.fetched_at nulls first, t.ticker;

-- Liquid stocks (the momentum pool, loosely) keep a longer history than the rest.
create or replace function public.ss_long_history_tickers()
returns table (ticker text)
language sql stable
set search_path = public
as $$
  select i.ticker from ss_indicators i
  where i.close >= 5 and i.avg_vol20 * i.close >= 5e6
  union
  select 'SPY'
$$;

-- New signature: drop the old one so calls with only p_days are not ambiguous.
drop function if exists public.ss_prune_bars(integer);
create or replace function public.ss_prune_bars(p_days integer default 400, p_long_days integer default 460)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare v_count integer;
begin
  delete from ss_daily_bars b
  where b.d < current_date - p_days
    and not exists (select 1 from ss_watchlist_items w where w.ticker = b.ticker)
    and (b.d < current_date - p_long_days
         or not exists (select 1 from ss_long_history_tickers() l where l.ticker = b.ticker));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Per-ticker raw inputs on signal date p_t for the given tickers (the build passes only names that
-- already passed the cheap price and market-cap filters, which keeps this fast). j = trading days back from p_t (0 = p_t); n = bars stored up to p_t.
--   MOM inputs: C[t−skip], C[t−look]; H52: max close over j < p_high; σ = stdev of log returns × √252.
--   ATR (Wilder): TR = max(H−L, |H−Cprev|, |L−Cprev|), seeded with the mean of the oldest p_atr TRs,
--   then ATR = ((p_atr−1)·ATR + TR) / p_atr. Written in closed form:
--   ATR_t = (1−α)^(m−p) · seed + Σ_{j < m−p} α(1−α)^j · TR_j, α = 1/p, m = n − 1 TRs.
drop function if exists public.ss_mom_metrics(date, real, integer, integer, integer, integer, integer, integer);
drop function if exists public.ss_mom_metrics(date, text[], integer, integer, integer, integer, integer, integer);
create or replace function public.ss_mom_metrics(
  p_t date, p_tickers text[], p_skip integer default 21, p_look integer default 252,
  p_high integer default 252, p_vol integer default 63, p_atr integer default 20, p_hist integer default 273
)
returns table (
  ticker text, close float8, market_cap numeric, sic_code text, n integer,
  c_skip float8, c_look float8, hi float8, days_since_high integer,
  median_dv60 float8, sigma float8, vol20 float8, atr float8,
  gain15_d date, zero_vol_d date, big_move_d date,
  window_start date, window_bars integer
)
language sql stable
set search_path = public
as $$
  with cand as (
    select t.ticker, t.market_cap, t.sic_code
    from ss_tickers t
    where t.ticker = any (p_tickers)
  ),
  b as (
    select b.ticker, b.d, b.h::float8 as h, b.l::float8 as l, b.c::float8 as c, b.v,
           lag(b.c::float8) over (partition by b.ticker order by b.d) as pc,
           lag(b.d) over (partition by b.ticker order by b.d) as pd,
           (row_number() over (partition by b.ticker order by b.d desc) - 1)::int as j,
           (count(*) over (partition by b.ticker))::int as n
    from ss_daily_bars b join cand using (ticker)
    where b.d <= p_t
  ),
  x as (
    select b.*,
           case when pc > 0 then greatest(h - l, abs(h - pc), abs(l - pc)) end as tr,
           case when pc > 0 and c > 0 then ln(c / pc) end as lr,
           case when pc > 0 and abs(c / pc - 1) > 0.40 then
             exists (select 1 from ss_splits s where s.ticker = b.ticker and s.execution_date > b.pd and s.execution_date <= b.d)
           end as has_split
    from b
  ),
  agg as (
    select x.ticker, max(x.n) as n,
      max(x.c) filter (where x.j = 0) as close,
      max(x.c) filter (where x.j = p_skip) as c_skip,
      max(x.c) filter (where x.j = p_look) as c_look,
      max(x.c) filter (where x.j < p_high) as hi,
      percentile_cont(0.5) within group (order by x.c * x.v) filter (where x.j < 60) as median_dv60,
      stddev_samp(x.lr) filter (where x.j < p_vol) * sqrt(252) as sigma,
      stddev_samp(x.lr) filter (where x.j < 20) * sqrt(252) as vol20,
      case when max(x.n) - 1 >= p_atr then
        power(1 - 1.0 / p_atr, max(x.n) - 1 - p_atr) * avg(x.tr) filter (where x.j >= x.n - 1 - p_atr and x.tr is not null)
        + coalesce(sum((1.0 / p_atr) * power(1 - 1.0 / p_atr, x.j) * x.tr) filter (where x.j < x.n - 1 - p_atr), 0)
      end as atr,
      max(x.d) filter (where x.d > p_t - 90 and x.pc > 0 and x.c / x.pc - 1 > 0.15) as gain15_d,
      max(x.d) filter (where x.j < p_hist and x.v = 0) as zero_vol_d,
      max(x.d) filter (where x.j < p_hist and x.has_split = false) as big_move_d,
      min(x.d) filter (where x.j < p_hist) as window_start,
      (count(*) filter (where x.j < p_hist))::int as window_bars
    from x group by x.ticker
  ),
  dsh as (
    select x.ticker, min(x.j)::int as days_since_high
    from x join agg a on a.ticker = x.ticker
    where x.j < p_high and x.c = a.hi
    group by x.ticker
  )
  select a.ticker, a.close, c.market_cap, c.sic_code, a.n, a.c_skip, a.c_look, a.hi, d.days_since_high,
         a.median_dv60, a.sigma, a.vol20, a.atr, a.gain15_d, a.zero_vol_d, a.big_move_d,
         a.window_start, a.window_bars
  from agg a join cand c on c.ticker = a.ticker left join dsh d on d.ticker = a.ticker
$$;

-- Validation + universe filters (in order, counted) + signals + ranking snapshot for signal date p_t.
-- p_n = target position count N (hold test uses CompRank ≤ hold_comprank_mult × N).
-- Returns { funnel: [{step, count}], warnings: [...] } and records the run.
create or replace function public.ss_mom_build(p_t date, p_kind text, p_cfg jsonb, p_n integer)
returns jsonb
language plpgsql
set search_path = public
set work_mem = '64MB'
as $$
declare
  v_funnel jsonb := '[]'::jsonb;
  v_warn jsonb := '[]'::jsonb;
  v_n integer;
  v_min_price real := (p_cfg->>'min_price')::real;
  v_min_mcap numeric := (p_cfg->>'min_market_cap')::numeric;
  v_min_dv float8 := (p_cfg->>'min_median_dollar_vol_60d')::float8;
  v_min_hist integer := (p_cfg->>'min_history_days')::integer;
  v_no_mcap integer;
  v_news_days integer;
begin
  drop table if exists _c;
  drop table if exists _m;
  -- Steps 1–3 need no history, so they run first and the expensive metrics only cover survivors.
  create temp table _c on commit drop as
  select t.ticker, t.market_cap, b.c
  from ss_tickers t join ss_daily_bars b on b.ticker = t.ticker and b.d = p_t
  where t.active and t.type = 'CS' and t.exchange in ('XNYS', 'XNAS', 'XASE');
  select count(*) into v_n from _c;
  v_funnel := v_funnel || jsonb_build_object('step', 'Common stock on NYSE / Nasdaq / NYSE American', 'count', v_n);

  delete from _c where c < v_min_price;
  select count(*) into v_n from _c;
  v_funnel := v_funnel || jsonb_build_object('step', format('Close ≥ $%s', v_min_price), 'count', v_n);

  -- Only liquid names without a market cap are worth a warning (the rest fail the volume step anyway).
  select count(*) into v_no_mcap from _c
  join ss_indicators i using (ticker)
  where _c.market_cap is null and i.avg_vol20 * i.close >= v_min_dv / 2;
  delete from _c where market_cap is null or market_cap < v_min_mcap;
  select count(*) into v_n from _c;
  v_funnel := v_funnel || jsonb_build_object('step', format('Market cap ≥ $%sB', round(v_min_mcap / 1e9, 1)), 'count', v_n);
  if v_no_mcap > 0 then
    v_warn := v_warn || to_jsonb(format('%s stocks have no market cap loaded yet and were excluded (the fundamentals job is filling them in).', v_no_mcap));
  end if;

  create temp table _m on commit drop as
  select * from ss_mom_metrics(
    p_t, (select array_agg(ticker) from _c), (p_cfg->>'mom_skip')::int, (p_cfg->>'mom_lookback')::int, (p_cfg->>'high_window')::int,
    (p_cfg->>'vol_lookback')::int, (p_cfg->>'atr_period')::int, v_min_hist);

  -- Validation flags (only for tickers that pass the cheap filters, i.e. could matter).
  insert into ss_data_flags (ticker, kind, d, detail)
  select m.ticker, 'zero_volume', m.zero_vol_d, 'Zero volume' from _m m
  where m.zero_vol_d is not null and m.median_dv60 >= v_min_dv
  on conflict do nothing;
  insert into ss_data_flags (ticker, kind, d, detail)
  select m.ticker, 'big_move', m.big_move_d, '1-day move over 40% with no split on record' from _m m
  where m.big_move_d is not null and m.median_dv60 >= v_min_dv
  on conflict do nothing;
  insert into ss_data_flags (ticker, kind, d, detail)
  select s.ticker, 'split_unrepaired', s.execution_date,
         format('%s-for-%s split; stored bars not re-fetched yet', s.split_to, s.split_from)
  from ss_splits s join _m m on m.ticker = s.ticker
  where s.needs_repair and s.repaired_at is null
  on conflict do nothing;
  -- A re-fetched (repaired) split clears its own flag.
  update ss_data_flags f set cleared = true, cleared_at = now()
  from ss_splits s
  where f.kind = 'split_unrepaired' and not f.cleared
    and s.ticker = f.ticker and s.execution_date = f.d and s.repaired_at is not null;
  insert into ss_data_flags (ticker, kind, d, detail)
  select m.ticker, 'missing_day', max(ld.d), 'Missing trading day(s) in the history window'
  from _m m
  join ss_loaded_days ld on ld.rows > 0 and ld.d between m.window_start and p_t
  where m.median_dv60 >= v_min_dv
    and not exists (select 1 from ss_daily_bars b where b.ticker = m.ticker and b.d = ld.d)
  group by m.ticker
  on conflict do nothing;
  -- Possible pending buyout (review only): very low volatility after a > 15% one-day jump.
  insert into ss_data_flags (ticker, kind, d, detail, excludes)
  select m.ticker, 'buyout_review', m.gain15_d,
         format('20-day vol %s%% after a >15%% one-day gain', round((m.vol20 * 100)::numeric, 1)), false
  from _m m
  where m.gain15_d is not null and m.vol20 < 0.08 and m.median_dv60 >= v_min_dv
  on conflict do nothing;

  delete from _m m where m.median_dv60 is null or m.median_dv60 < v_min_dv;
  select count(*) into v_n from _m;
  v_funnel := v_funnel || jsonb_build_object('step', format('Median 60-day dollar volume ≥ $%sM', v_min_dv / 1e6), 'count', v_n);

  delete from _m m where m.n < v_min_hist or m.c_look is null or m.c_skip is null;
  select count(*) into v_n from _m;
  v_funnel := v_funnel || jsonb_build_object('step', format('≥ %s days of history', v_min_hist), 'count', v_n);

  delete from _m m where exists (
    select 1 from ss_data_flags f
    where f.ticker = m.ticker and f.kind = 'buyout_news' and not f.cleared and f.d > p_t - 90);
  select count(*) into v_n from _m;
  v_funnel := v_funnel || jsonb_build_object('step', 'No acquisition-agreement news (90 days)', 'count', v_n);
  select count(*) into v_news_days from ss_news_days where d > p_t - 90;
  if v_news_days < 85 then
    v_warn := v_warn || to_jsonb(format('News sweep covers %s of the last 90 days; buyout screening is incomplete until it catches up.', v_news_days));
  end if;

  delete from _m m where exists (
    select 1 from ss_data_flags f
    where f.ticker = m.ticker and f.excludes and not f.cleared and f.kind <> 'buyout_news');
  select count(*) into v_n from _m;
  v_funnel := v_funnel || jsonb_build_object('step', 'No uncleared data flags', 'count', v_n);
  if v_n < 500 or v_n > 1500 then
    v_warn := v_warn || to_jsonb(format('Universe has %s names (expected ~800–1,200; warning outside 500–1,500).', v_n));
  end if;

  delete from ss_mom_snapshots where signal_date = p_t;
  insert into ss_mom_snapshots (signal_date, ticker, close, market_cap, sic2, median_dv60, bars, mom, h52, days_since_high,
                                mom_pct, h52_pct, composite, comp_rank, sigma63, atr20, entry_ok, hold_ok)
  with s as (
    select m.*, m.c_skip / m.c_look - 1 as mom, m.close / m.hi as h52 from _m m
  ),
  r as (
    select s.*, percent_rank() over (order by s.mom) * 100 as mom_pct, percent_rank() over (order by s.h52) * 100 as h52_pct
    from s
  ),
  c as (
    select r.*, 0.5 * r.mom_pct + 0.5 * r.h52_pct as composite from r
  ),
  k as (
    select c.*, row_number() over (order by c.composite desc, c.mom desc)::int as comp_rank from c
  )
  select p_t, k.ticker, k.close, k.market_cap, left(k.sic_code, 2), k.median_dv60, k.n, k.mom, k.h52, k.days_since_high,
         k.mom_pct, k.h52_pct, k.composite, k.comp_rank, k.sigma, k.atr,
         k.mom_pct >= (p_cfg->>'entry_mom_pct')::float8 and k.h52 >= (p_cfg->>'entry_h52')::float8
           and k.days_since_high <= (p_cfg->>'entry_max_days_since_high')::int,
         k.mom_pct >= (p_cfg->>'hold_mom_pct')::float8 and k.h52 >= (p_cfg->>'hold_h52')::float8
           and k.comp_rank <= (p_cfg->>'hold_comprank_mult')::int * p_n
  from k;

  insert into ss_mom_runs (signal_date, kind, n, funnel, warnings)
  values (p_t, p_kind, p_n, v_funnel, v_warn)
  on conflict (signal_date, kind) do update set n = excluded.n, funnel = excluded.funnel, warnings = excluded.warnings, created_at = now();

  -- Keep weekly/monthly snapshots; daily ones only for the last 10 days.
  delete from ss_mom_snapshots s
  where s.signal_date < p_t - 10
    and not exists (select 1 from ss_mom_runs r where r.signal_date = s.signal_date and r.kind in ('weekly', 'monthly'));

  return jsonb_build_object('funnel', v_funnel, 'warnings', v_warn);
end;
$$;

-- Daily momentum job: after the EOD load (10:05) and before the options scan (10:25).
select cron.schedule('ss-momentum', '15 10 * * 2-6', $$select public.ss_call_app('/api/cron/momentum')$$);

-- A split needs a re-fetch when some bar dated before it was loaded before (or on) the split date:
-- that bar was split-adjusted as of its load time, so it is on the pre-split scale.
create or replace function public.ss_mark_split_repairs()
returns integer
language plpgsql
set search_path = public
as $$
declare v integer;
begin
  update ss_splits s set needs_repair = true
  where s.repaired_at is null and not s.needs_repair
    and exists (
      select 1 from ss_daily_bars b join ss_loaded_days ld on ld.d = b.d
      where b.ticker = s.ticker and b.d < s.execution_date
        and ld.loaded_at < s.execution_date + interval '1 day');
  select count(*) into v from ss_splits where needs_repair and repaired_at is null;
  return v;
end;
$$;

-- Tickers waiting for a split repair, liquid (long-history) names first, with their first stored bar.
create or replace function public.ss_split_repair_queue()
returns table (ticker text, first_d date)
language sql stable
set search_path = public
as $$
  select s.ticker, (select min(b.d) from ss_daily_bars b where b.ticker = s.ticker) as first_d
  from (select distinct ticker from ss_splits where needs_repair and repaired_at is null) s
  where exists (select 1 from ss_daily_bars b where b.ticker = s.ticker)
  order by (s.ticker in (select l.ticker from ss_long_history_tickers() l)) desc, s.ticker
$$;
