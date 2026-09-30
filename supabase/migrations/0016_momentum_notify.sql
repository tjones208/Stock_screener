-- Morning momentum push (sells + reasons) every trading day, after the 10:15 UTC momentum job.
select cron.schedule('ss-momentum-notify', '45 11 * * 1-5', $$select public.ss_call_app('/api/cron/momentum-notify', 60000)$$);
