-- ss_pb_universe as one JSON value: PostgREST pages set results 1,000 rows at a time, and each page
-- re-ran the whole query. Returns {"total": tickers with a bar on the latest day, "rows": [...]} with
-- only the rows the scan can rank (a close p_lookback sessions back). The set-returning
-- ss_pb_universe from 0028 is left in place, unused.
create or replace function public.ss_pb_universe_json(p_days integer, p_lookback integer, p_dv_days integer, p_mid integer, p_slow integer, p_market text default 'SPY')
returns jsonb
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
  ),
  r as (
    select a.ticker, t.type, a.n, a.c, a.c_lb, a.adv, a.ma_mid, a.ma_slow,
           exists (select 1 from ss_data_flags f where f.ticker = a.ticker and not f.cleared and f.excludes) as flagged
    from agg a left join ss_tickers t on t.ticker = a.ticker
  )
  select jsonb_build_object('total', (select count(*) from r),
                            'rows', coalesce((select jsonb_agg(to_jsonb(r)) from r where r.c_lb is not null), '[]'::jsonb))
$$;

revoke all on function public.ss_pb_universe_json(integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ss_pb_universe_json(integer, integer, integer, integer, integer, text) to service_role;
