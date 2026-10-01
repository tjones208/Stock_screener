-- The nightly indicator refresh (~1.5 min) outgrew the API gateway's request timeout when called
-- from the app ("upstream request timeout"). It now runs inside Postgres via pg_cron at 10:10 UTC,
-- after the 10:05 bar load and before the 10:25 alerts. The app only loads bars.
create or replace function public.ss_nightly_maintenance()
returns void
language plpgsql
set search_path = public
as $$
declare
  v_id bigint;
  v_rows integer;
  v_pruned integer;
  v_t0 timestamptz := clock_timestamp();
begin
  insert into ss_job_runs (job) values ('indicators') returning id into v_id;
  begin
    v_rows := ss_refresh_indicators();
    v_pruned := ss_prune_bars(400, 460);
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

select cron.schedule('ss-indicators', '10 10 * * 2-6', $$set statement_timeout = '600s'; select public.ss_nightly_maintenance()$$);

-- Backfill (and anything else in the app) asks for a refresh by queueing a one-shot pg_cron job.
create or replace function public.ss_queue_maintenance()
returns void
language plpgsql
security definer
set search_path = public, cron
as $$
begin
  if not exists (select 1 from cron.job where jobname = 'ss-indicators-once') then
    perform cron.schedule('ss-indicators-once', '* * * * *',
      $job$set statement_timeout = '600s'; select public.ss_nightly_maintenance(); select cron.unschedule('ss-indicators-once')$job$);
  end if;
end;
$$;
revoke all on function public.ss_queue_maintenance() from public, anon, authenticated;
grant execute on function public.ss_queue_maintenance() to service_role;
