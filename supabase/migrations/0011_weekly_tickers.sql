-- Weekly ticker-list refresh as its own job (it pushed the Tuesday EOD run past Vercel's 300s limit).
-- Sundays 12:05 UTC; the fundamentals job pauses nothing here, and no bars load on Sundays.
select cron.schedule('ss-tickers', '5 12 * * 0', $$select public.ss_call_app('/api/cron/tickers')$$);
