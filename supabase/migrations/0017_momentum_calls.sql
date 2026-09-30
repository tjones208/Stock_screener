-- Covered calls on momentum positions (100+ shares only). Calls you sold, and the nightly suggestion per position.
create table if not exists public.ss_mom_calls (
  id           bigserial primary key,
  ticker       text not null,
  contract     text not null,                 -- OCC symbol
  expiration   date not null,
  strike       real not null,
  contracts    integer not null,
  premium      real not null,                 -- per share received when sold
  opened_at    timestamptz not null,
  status       text not null default 'open',  -- open | expired | bought_back | assigned | assign_pending
  close_price  real,                          -- per share paid to buy back
  closed_at    timestamptz,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists ss_mom_calls_open_idx on public.ss_mom_calls (ticker) where status in ('open', 'assign_pending');

create table if not exists public.ss_mom_call_ideas (
  ticker      text primary key,
  as_of       date not null,
  contracts   integer not null,
  contract    text,
  expiration  date,
  strike      real,
  dte         integer,
  bid         real,
  ask         real,
  mid         real,
  delta       real,
  iv          real,
  open_interest integer,
  error       text,
  updated_at  timestamptz not null default now()
);

alter table public.ss_mom_calls enable row level security;
alter table public.ss_mom_call_ideas enable row level security;
