-- Momentum part B: ranking v2 (risk-adjusted composite, hold buffer, absolute momentum, buyout
-- review), held names kept in the snapshot when they leave the universe, a dry-run build, trailing
-- stop that resizes with price, tax tracking, the equity journal, and benchmark bars kept forever.
--
-- The new build is a separate overload (p_held, p_dry) so the existing 4-argument ss_mom_build keeps
-- working until the app code that calls the new one is deployed; 0024 drops the old one.

-- ───────────── Columns ─────────────
alter table public.ss_mom_lots
  add column if not exists d_trail real,               -- today's trailing distance D_t (lots.d stays the initial risk)
  add column if not exists lt_deferred_trigger integer, -- exit trigger (3, 7, 9) waiting for lt_date
  add column if not exists lt_deferred_reason text,
  add column if not exists lt_deferred_on date;

alter table public.ss_mom_snapshots
  add column if not exists sigma252 real,
  add column if not exists composite_classic real,
  add column if not exists composite_risk_adj real,
  add column if not exists held_outside_universe boolean not null default false,
  add column if not exists outside_reason text,
  add column if not exists hold_reason text,
  add column if not exists entry_reason text;

-- ───────────── Equity journal ─────────────
create table if not exists public.ss_mom_equity (
  d               date primary key,
  b               real not null,      -- strategy buying power that night
  invested        real not null,      -- cost of open lots
  open_value      real not null,      -- open lots at the close
  realized        real not null,      -- realized P&L to date
  cash            real not null,      -- B − invested
  strategy_value  real not null,      -- open_value + realized + cash
  spy_value       real,               -- SPY from the same start value
  mtum_value      real,               -- MTUM from the same start value
  realized_st_ytd real not null default 0,
  realized_lt_ytd real not null default 0,
  tax_est         real not null default 0,
  after_tax_value real,
  vol_scale       real,               -- volatility brake m that night
  created_at      timestamptz not null default now()
);
alter table public.ss_mom_equity enable row level security;

-- ───────────── Benchmarks are never pruned ─────────────
create or replace function public.ss_prune_bars(p_days integer default 400, p_long_days integer default 460)
returns integer language plpgsql set search_path = public as $$
declare v_count integer;
begin
  delete from ss_daily_bars b
  where b.d < current_date - p_days
    -- Regime, benchmark and cash-ETF bars are kept for the equity journal and the regime filter.
    and b.ticker not in ('SPY', 'MTUM', 'SPMO', 'SGOV')
    and not exists (select 1 from ss_watchlist_items w where w.ticker = b.ticker)
    and not exists (select 1 from ss_mom_lots l where l.ticker = b.ticker and l.exit_date is null)
    and (b.d < current_date - p_long_days
         or not exists (select 1 from ss_long_history_tickers() l where l.ticker = b.ticker));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ───────────── Metrics: + sigma252 and the oldest close in the lookback ─────────────
drop function if exists public.ss_mom_metrics(date, text[], integer, integer, integer, integer, integer, integer);
create or replace function public.ss_mom_metrics(
  p_t date, p_tickers text[], p_skip integer default 21, p_look integer default 252, p_high integer default 252,
  p_vol integer default 63, p_atr integer default 20, p_hist integer default 273)
returns table(ticker text, close double precision, market_cap numeric, sic_code text, n integer, c_skip double precision,
  c_look double precision, hi double precision, days_since_high integer, median_dv60 double precision, sigma double precision,
  vol20 double precision, atr double precision, gain15_d date, zero_vol_d date, big_move_d date, window_start date,
  window_bars integer, sigma252 double precision, c_first double precision)
language sql stable set search_path = public as $$
  with cand as (
    select t.ticker, t.market_cap, t.sic_code from ss_tickers t where t.ticker = any (p_tickers)
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
      (count(*) filter (where x.j < p_hist))::int as window_bars,
      case when count(x.lr) filter (where x.j < 252) >= 200 then stddev_samp(x.lr) filter (where x.j < 252) * sqrt(252) end as sigma252,
      max(x.c) filter (where x.j = least(p_look, x.n - 1)) as c_first
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
         a.window_start, a.window_bars, a.sigma252, a.c_first
  from agg a join cand c on c.ticker = a.ticker left join dsh d on d.ticker = a.ticker
$$;

-- ───────────── Build v2 ─────────────
-- p_held: tickers with open lots (always get a snapshot row, marked held_outside_universe when
-- they fail a universe filter). p_dry: compute everything but write nothing (no flags, snapshot or
-- run row); the rows come back in the result instead.
create or replace function public.ss_mom_build(p_t date, p_kind text, p_cfg jsonb, p_n integer, p_held text[], p_dry boolean)
returns jsonb language plpgsql set search_path = public set work_mem = '64MB' as $$
declare
  v_funnel jsonb := '[]'::jsonb;
  v_warn jsonb := '[]'::jsonb;
  v_n integer;
  v_universe integer;
  v_cutoff integer;
  v_min_price real := (p_cfg->>'min_price')::real;
  v_min_mcap numeric := (p_cfg->>'min_market_cap')::numeric;
  v_min_dv float8 := (p_cfg->>'min_median_dollar_vol_60d')::float8;
  v_min_hist integer := (p_cfg->>'min_history_days')::integer;
  v_method text := coalesce(p_cfg->>'rank_method', 'risk_adj');
  v_abs float8 := coalesce((p_cfg->>'abs_mom_min')::float8, 0);
  v_hold_pct float8 := coalesce((p_cfg->>'hold_rank_pct')::float8, 0);
  v_held text[] := coalesce(p_held, '{}');
  v_no_mcap integer;
  v_news_days integer;
  v_rows jsonb;
begin
  drop table if exists _c;
  drop table if exists _m;
  drop table if exists _k;
  -- Universe candidates, plus every held ticker that traded on p_t whatever its type or exchange.
  create temp table _c on commit drop as
  select t.ticker, t.market_cap, b.c, t.ticker = any (v_held) as held,
         case when not (t.active and t.type = 'CS' and t.exchange in ('XNYS', 'XNAS', 'XASE')) then 'Not an active common stock on NYSE / Nasdaq / NYSE American' end as out_reason
  from ss_tickers t join ss_daily_bars b on b.ticker = t.ticker and b.d = p_t
  where (t.active and t.type = 'CS' and t.exchange in ('XNYS', 'XNAS', 'XASE')) or t.ticker = any (v_held);
  select count(*) into v_n from _c where out_reason is null;
  v_funnel := v_funnel || jsonb_build_object('step', 'Common stock on NYSE / Nasdaq / NYSE American', 'count', v_n);

  update _c set out_reason = coalesce(out_reason, format('Close below $%s', v_min_price)) where c < v_min_price and held;
  delete from _c where c < v_min_price and not held;
  select count(*) into v_n from _c where out_reason is null;
  v_funnel := v_funnel || jsonb_build_object('step', format('Close ≥ $%s', v_min_price), 'count', v_n);

  select count(*) into v_no_mcap from _c
  join ss_indicators i using (ticker)
  where _c.out_reason is null and _c.market_cap is null and i.avg_vol20 * i.close >= v_min_dv / 2;
  update _c set out_reason = coalesce(out_reason, case when market_cap is null then 'No market cap loaded' else 'Market cap below the minimum' end)
  where (market_cap is null or market_cap < v_min_mcap) and held;
  delete from _c where (market_cap is null or market_cap < v_min_mcap) and not held;
  select count(*) into v_n from _c where out_reason is null;
  v_funnel := v_funnel || jsonb_build_object('step', format('Market cap ≥ $%sB', round(v_min_mcap / 1e9, 1)), 'count', v_n);
  if v_no_mcap > 0 then
    v_warn := v_warn || to_jsonb(format('%s stocks have no market cap loaded yet and were excluded (the fundamentals job is filling them in).', v_no_mcap));
  end if;

  create temp table _m on commit drop as
  select mm.*, c.held, c.out_reason
  from ss_mom_metrics(
    p_t, (select array_agg(ticker) from _c), (p_cfg->>'mom_skip')::int, (p_cfg->>'mom_lookback')::int, (p_cfg->>'high_window')::int,
    (p_cfg->>'vol_lookback')::int, (p_cfg->>'atr_period')::int, v_min_hist) mm
  join _c c on c.ticker = mm.ticker;

  if not p_dry then
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
    insert into ss_data_flags (ticker, kind, d, detail, excludes)
    select m.ticker, 'buyout_review', m.gain15_d,
           format('20-day vol %s%% after a >15%% one-day gain', round((m.vol20 * 100)::numeric, 1)), false
    from _m m
    where m.gain15_d is not null and m.vol20 < 0.08 and m.median_dv60 >= v_min_dv
    on conflict do nothing;
  end if;

  update _m m set out_reason = coalesce(m.out_reason, 'Median 60-day dollar volume below the minimum')
  where (m.median_dv60 is null or m.median_dv60 < v_min_dv) and m.held;
  delete from _m m where (m.median_dv60 is null or m.median_dv60 < v_min_dv) and not m.held;
  select count(*) into v_n from _m where out_reason is null;
  v_funnel := v_funnel || jsonb_build_object('step', format('Median 60-day dollar volume ≥ $%sM', v_min_dv / 1e6), 'count', v_n);

  update _m m set out_reason = coalesce(m.out_reason, format('Fewer than %s days of history', v_min_hist))
  where (m.n < v_min_hist or m.c_look is null or m.c_skip is null) and m.held;
  delete from _m m where (m.n < v_min_hist or m.c_look is null or m.c_skip is null) and not m.held;
  select count(*) into v_n from _m where out_reason is null;
  v_funnel := v_funnel || jsonb_build_object('step', format('≥ %s days of history', v_min_hist), 'count', v_n);

  -- Acquisition news: held names stay (exit trigger 4 handles them); others leave the universe.
  update _m m set out_reason = coalesce(m.out_reason, 'Acquisition-agreement news')
  where m.held and exists (select 1 from ss_data_flags f
    where f.ticker = m.ticker and f.kind = 'buyout_news' and not f.cleared and f.d > p_t - 90);
  delete from _m m where not m.held and exists (
    select 1 from ss_data_flags f
    where f.ticker = m.ticker and f.kind = 'buyout_news' and not f.cleared and f.d > p_t - 90);
  select count(*) into v_n from _m where out_reason is null;
  v_funnel := v_funnel || jsonb_build_object('step', 'No acquisition-agreement news (90 days)', 'count', v_n);
  select count(*) into v_news_days from ss_news_days where d > p_t - 90;
  if v_news_days < 85 then
    v_warn := v_warn || to_jsonb(format('News sweep covers %s of the last 90 days; buyout screening is incomplete until it catches up.', v_news_days));
  end if;

  -- Data flags take names out of the universe but never force a held name out.
  update _m m set out_reason = coalesce(m.out_reason, 'Uncleared data flag')
  where m.held and exists (select 1 from ss_data_flags f
    where f.ticker = m.ticker and f.excludes and not f.cleared and f.kind <> 'buyout_news');
  delete from _m m where not m.held and exists (
    select 1 from ss_data_flags f
    where f.ticker = m.ticker and f.excludes and not f.cleared and f.kind <> 'buyout_news');
  select count(*) into v_universe from _m where out_reason is null;
  v_funnel := v_funnel || jsonb_build_object('step', 'No uncleared data flags', 'count', v_universe);
  if v_universe < 500 or v_universe > 1500 then
    v_warn := v_warn || to_jsonb(format('Universe has %s names (expected ~800–1,200; warning outside 500–1,500).', v_universe));
  end if;

  -- Hold buffer: keep while CompRank ≤ max(hold_comprank_mult × N, ceil(hold_rank_pct × universe)).
  v_cutoff := greatest((p_cfg->>'hold_comprank_mult')::int * p_n, ceil(v_hold_pct * v_universe)::int);

  -- Ranking. Percentiles come from universe names only; a held name outside the universe is placed
  -- within that distribution (same percent_rank formula) using the bars it has.
  create temp table _k on commit drop as
  with s as (
    select m.*,
           coalesce(m.c_skip / nullif(m.c_look, 0), m.c_skip / nullif(m.c_first, 0)) - 1 as mom,
           m.close / nullif(m.hi, 0) as h52
    from _m m
  ),
  s2 as (select s.*, case when s.sigma252 > 0 then s.mom / s.sigma252 end as mom_risk from s),
  u as (select * from s2 where out_reason is null),
  r as (
    select s2.*,
      case when s2.out_reason is null then (percent_rank() over (partition by s2.out_reason is null order by s2.mom)) * 100
           else 100.0 * (select count(*) from u where u.mom < s2.mom) / greatest((select count(*) from u) - 1, 1) end as mom_pct,
      case when s2.out_reason is null then (percent_rank() over (partition by s2.out_reason is null order by s2.h52)) * 100
           else 100.0 * (select count(*) from u where u.h52 < s2.h52) / greatest((select count(*) from u) - 1, 1) end as h52_pct,
      -- Names without σ252 sort to the bottom of the risk-adjusted percentile.
      case when s2.out_reason is null then (percent_rank() over (partition by s2.out_reason is null order by s2.mom_risk nulls first)) * 100
           else 100.0 * (select count(*) from u where u.mom_risk < s2.mom_risk) / greatest((select count(*) from u) - 1, 1) end as risk_pct
    from s2
  ),
  c as (
    select r.*,
           0.5 * r.mom_pct + 0.5 * r.h52_pct as composite_classic,
           0.75 * r.risk_pct + 0.25 * r.h52_pct as composite_risk_adj
    from r
  ),
  c2 as (select c.*, case when v_method = 'classic' then c.composite_classic else c.composite_risk_adj end as composite from c),
  k as (
    select c2.*,
      case when c2.out_reason is null then (row_number() over (partition by c2.out_reason is null order by c2.composite desc, c2.mom desc))::int
           else 1 + (select count(*) from c2 x where x.out_reason is null and (x.composite > c2.composite or (x.composite = c2.composite and x.mom > c2.mom)))::int end as comp_rank
    from c2
  ),
  rev as (select distinct f.ticker from ss_data_flags f where f.kind = 'buyout_review' and not f.cleared)
  select k.*, k.ticker in (select ticker from rev) as review,
    case
      when k.out_reason is not null then 'Outside the universe: ' || k.out_reason
      when k.ticker in (select ticker from rev) then 'Possible pending buyout'
      when not (k.mom > v_abs) then format('Momentum %s%% is not above %s%%', round((k.mom * 100)::numeric, 1), round((v_abs * 100)::numeric, 1))
      when k.mom_pct < (p_cfg->>'entry_mom_pct')::float8 then 'Momentum percentile below the entry minimum'
      when k.h52 < (p_cfg->>'entry_h52')::float8 then 'H52 below the entry minimum'
      when k.days_since_high > (p_cfg->>'entry_max_days_since_high')::int then 'Too long since the 52-week high'
    end as entry_reason,
    case
      when k.ticker in (select ticker from rev) then 'Possible pending buyout'
      when k.close < v_min_price then format('Close below $%s', v_min_price)
      when k.median_dv60 is null or k.median_dv60 < 0.5 * v_min_dv then 'Median 60-day dollar volume under half the minimum'
      when k.mom_pct < (p_cfg->>'hold_mom_pct')::float8 then 'Momentum percentile below the hold minimum'
      when k.h52 < (p_cfg->>'hold_h52')::float8 then 'H52 below the hold minimum'
      when k.comp_rank > v_cutoff then format('CompRank %s is past the hold cutoff %s', k.comp_rank, v_cutoff)
    end as hold_reason
  from k;

  if p_dry then
    select jsonb_agg(jsonb_build_object(
      'ticker', ticker, 'close', close, 'mom', mom, 'h52', h52, 'mom_pct', mom_pct, 'h52_pct', h52_pct, 'sigma63', sigma, 'sigma252', sigma252,
      'atr20', atr, 'days_since_high', days_since_high, 'composite', composite, 'composite_classic', composite_classic,
      'composite_risk_adj', composite_risk_adj, 'comp_rank', comp_rank, 'entry_ok', entry_reason is null, 'hold_ok', hold_reason is null,
      'entry_reason', entry_reason, 'hold_reason', hold_reason, 'held_outside_universe', out_reason is not null) order by comp_rank)
    into v_rows from _k;
  else
    delete from ss_mom_snapshots where signal_date = p_t;
    insert into ss_mom_snapshots (signal_date, ticker, close, market_cap, sic2, median_dv60, bars, mom, h52, days_since_high,
                                  mom_pct, h52_pct, composite, comp_rank, sigma63, atr20, entry_ok, hold_ok,
                                  sigma252, composite_classic, composite_risk_adj, held_outside_universe, outside_reason, hold_reason, entry_reason)
    select p_t, k.ticker, k.close, k.market_cap, left(k.sic_code, 2), k.median_dv60, k.n, k.mom, k.h52, k.days_since_high,
           k.mom_pct, k.h52_pct, k.composite, k.comp_rank, k.sigma, k.atr, k.entry_reason is null, k.hold_reason is null,
           k.sigma252, k.composite_classic, k.composite_risk_adj, k.out_reason is not null, k.out_reason, k.hold_reason, k.entry_reason
    from _k k;

    insert into ss_mom_runs (signal_date, kind, n, funnel, warnings)
    values (p_t, p_kind, p_n, v_funnel, v_warn)
    on conflict (signal_date, kind) do update set n = excluded.n, funnel = excluded.funnel, warnings = excluded.warnings, created_at = now();

    delete from ss_mom_snapshots s
    where s.signal_date < p_t - 10
      and not exists (select 1 from ss_mom_runs r where r.signal_date = s.signal_date and r.kind in ('weekly', 'monthly'));
  end if;

  return jsonb_build_object('funnel', v_funnel, 'warnings', v_warn, 'universe', v_universe, 'hold_cutoff', v_cutoff,
    'hold_cutoff_classic', (p_cfg->>'hold_comprank_mult')::int * p_n, 'rows', v_rows);
end;
$$;
