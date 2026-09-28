-- User settings (position sizing, etc.) — one JSON document per key. Service role only.
create table if not exists public.ss_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.ss_settings enable row level security;
revoke all on public.ss_settings from anon, authenticated;
