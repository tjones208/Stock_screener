-- Massive's free plan refuses a day's grouped bars until well after the close
-- ("Attempted to request today's data before end of day"), so the EOD job now runs the next
-- morning and loads the previous trading day; the options scan + alerts follow before the open.
-- Scheduling an existing job name replaces its schedule.
select cron.schedule('ss-eod',     '5 10 * * 2-6',  $$select public.ss_call_app('/api/cron/eod')$$);     -- ≈ 6:05am ET
select cron.schedule('ss-options', '25 10 * * 2-6', $$select public.ss_call_app('/api/cron/options')$$); -- ≈ 6:25am ET
