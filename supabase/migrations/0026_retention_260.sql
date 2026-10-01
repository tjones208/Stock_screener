-- Retention to stay under the 500 MB free tier:
--   • every ticker outside the liquid long-history list keeps ~260 trading days (screener needs:
--     200-day SMA, 52-week high);
--   • liquid names (ss_long_history_tickers) keep 460 calendar days (~316 trading days; momentum
--     needs 273 days of history plus the 252-day lookback);
--   • SPY / MTUM / SPMO / SGOV, open momentum lots and watchlist tickers are never pruned.
-- Size guard: if the database is still over p_cap_mb after that, liquid names are cut to 300
-- trading days (still ≥ the 273-day history test) and the run reports it.

drop function if exists public.ss_prune_bars(integer, integer);
create or replace function public.ss_prune_bars(p_trading_days integer default 260, p_long_days integer default 460, p_cap_mb integer default 475)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_short date;
  v_long date := current_date - p_long_days;
  v_guard date;
  v_short_n integer;
  v_long_n integer;
  v_guard_n integer := 0;
  v_mb integer;
begin
  -- The p_trading_days-th most recent trading day with data.
  select d into v_short from (select d from ss_loaded_days where rows > 0 order by d desc limit p_trading_days) x order by d limit 1;

  create temp table _keep on commit drop as
  select ticker from ss_long_history_tickers()
  union select unnest(array['SPY', 'MTUM', 'SPMO', 'SGOV']);

  delete from ss_daily_bars b
  where v_short is not null and b.d < v_short
    and b.ticker not in (select ticker from _keep)
    and not exists (select 1 from ss_watchlist_items w where w.ticker = b.ticker)
    and not exists (select 1 from ss_mom_lots l where l.ticker = b.ticker and l.exit_date is null);
  get diagnostics v_short_n = row_count;

  delete from ss_daily_bars b
  where b.d < v_long
    and b.ticker not in ('SPY', 'MTUM', 'SPMO', 'SGOV')
    and not exists (select 1 from ss_watchlist_items w where w.ticker = b.ticker)
    and not exists (select 1 from ss_mom_lots l where l.ticker = b.ticker and l.exit_date is null);
  get diagnostics v_long_n = row_count;

  v_mb := (pg_database_size(current_database()) / 1048576)::int;
  if v_mb > p_cap_mb then
    select d into v_guard from (select d from ss_loaded_days where rows > 0 order by d desc limit 300) x order by d limit 1;
    delete from ss_daily_bars b
    where v_guard is not null and b.d < v_guard
      and b.ticker not in ('SPY', 'MTUM', 'SPMO', 'SGOV')
      and not exists (select 1 from ss_watchlist_items w where w.ticker = b.ticker)
      and not exists (select 1 from ss_mom_lots l where l.ticker = b.ticker and l.exit_date is null);
    get diagnostics v_guard_n = row_count;
  end if;

  return jsonb_build_object('short', v_short_n, 'long', v_long_n, 'guard', v_guard_n, 'db_mb', v_mb, 'cap_mb', p_cap_mb,
    'short_cutoff', v_short, 'long_cutoff', v_long);
end;
$$;

create or replace function public.ss_nightly_maintenance()
returns void language plpgsql set search_path = public as $$
declare
  v_id bigint;
  v_rows integer;
  v_pruned jsonb;
  v_t0 timestamptz := clock_timestamp();
begin
  insert into ss_job_runs (job) values ('indicators') returning id into v_id;
  begin
    v_rows := ss_refresh_indicators();
    v_pruned := ss_prune_bars(260, 460, 475);
    update ss_job_runs set status = 'ok', finished_at = now(),
      detail = jsonb_build_object('indicators', v_rows, 'pruned', v_pruned,
                                  'as_of', (select max(as_of) from ss_indicators),
                                  'seconds', round(extract(epoch from clock_timestamp() - v_t0)::numeric, 1))
    where id = v_id;
  exception when others then
    update ss_job_runs set status = 'error', finished_at = now(), detail = jsonb_build_object('error', sqlerrm) where id = v_id;
  end;
end;
$$;
