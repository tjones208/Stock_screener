-- NOT YET APPLIED. Run after the first Vercel deploy.
-- Calls the app's cron routes from inside Supabase, because Vercel Hobby crons can only run once a day.
--
-- 1) Replace APP_URL below with your deployed URL (e.g. https://stock-screener-xyz.vercel.app).
-- 2) Store CRON_SECRET in Vault first (SQL editor, one time — don't commit the value):
--      select vault.create_secret('<your CRON_SECRET>', 'ss_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.ss_call_app(p_path text)
returns bigint
language sql
security definer
set search_path = public
as $$
  select net.http_get(
    url := 'APP_URL' || p_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ss_cron_secret')
    ),
    timeout_milliseconds := 5000   -- fire and forget; the route keeps running on Vercel
  );
$$;
revoke all on function public.ss_call_app(text) from public, anon, authenticated;

-- Fundamentals: every minute, 2 tickers per call (4 Massive calls, under the 5/min limit).
select cron.schedule('ss-fundamentals', '* * * * *', $$select public.ss_call_app('/api/cron/fundamentals')$$);

-- Backfill: every 6 minutes until history is complete, then unschedule it:
--   select cron.unschedule('ss-backfill');
select cron.schedule('ss-backfill', '*/6 * * * *', $$select public.ss_call_app('/api/cron/backfill')$$);
