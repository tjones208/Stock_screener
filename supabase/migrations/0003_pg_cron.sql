-- App secrets + all schedules run from Supabase (pg_cron + pg_net).
-- The cron token is generated here, inside Postgres, and read by both pg_cron and the app,
-- so it never has to be typed, copied or shown anywhere.

create table if not exists public.ss_app_secrets (
  name        text primary key,
  value       text not null,
  created_at  timestamptz not null default now()
);
alter table public.ss_app_secrets enable row level security;  -- no policies: service role only
revoke all on public.ss_app_secrets from anon, authenticated;

insert into public.ss_app_secrets (name, value)
values ('cron', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

insert into public.ss_app_secrets (name, value)
values ('app_url', 'https://stock-screener-five-ecru.vercel.app')
on conflict (name) do update set value = excluded.value;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Fire-and-forget GET to one of the app's /api/cron routes with the bearer token.
create or replace function public.ss_call_app(p_path text, p_timeout_ms integer default 300000)
returns bigint
language sql
security definer
set search_path = public, extensions
as $$
  select net.http_get(
    url := (select value from public.ss_app_secrets where name = 'app_url') || p_path,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from public.ss_app_secrets where name = 'cron')
    ),
    timeout_milliseconds := p_timeout_ms
  );
$$;
revoke all on function public.ss_call_app(text, integer) from public, anon, authenticated;

-- Times are UTC. 22:05 UTC = 6:05pm ET (EDT) / 5:05pm (EST) — after the close either way.
select cron.schedule('ss-eod',          '5 22 * * 1-5', $$select public.ss_call_app('/api/cron/eod')$$);
select cron.schedule('ss-options',      '5 0 * * 2-6',  $$select public.ss_call_app('/api/cron/options')$$);
select cron.schedule('ss-fundamentals', '* * * * *',    $$select public.ss_call_app('/api/cron/fundamentals', 60000)$$);
-- Fills missing history (~20 days per run); once caught up it's a no-op that also heals gaps.
select cron.schedule('ss-backfill',     '*/6 * * * *',  $$select public.ss_call_app('/api/cron/backfill')$$);
