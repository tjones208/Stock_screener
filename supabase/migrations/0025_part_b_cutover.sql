-- Part B cutover (applied after the app code that calls the 6-argument build is deployed).

-- The old 4-argument build is replaced by ss_mom_build(p_t, p_kind, p_cfg, p_n, p_held, p_dry) from 0023.
drop function if exists public.ss_mom_build(date, text, jsonb, integer);

-- 10:30 ET execution alert for urgent sells still open. pg_cron runs in UTC, so fire at both
-- 14:30 (EDT) and 15:30 (EST); the route only pushes at 10:30 New York time.
select cron.unschedule(jobid) from cron.job where jobname = 'ss-momentum-urgent';
select cron.schedule('ss-momentum-urgent', '30 14,15 * * 1-5', $$select public.ss_call_app('/api/cron/momentum-urgent', 60000)$$);
