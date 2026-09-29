-- Momentum step 5: order tickets and fills (lots). Exits, trailing stops and tax fields are filled in
-- by later steps; the lot row already carries every journal column from the spec (section 11).

create table if not exists public.ss_mom_tickets (
  id               bigserial primary key,
  signal_date      date not null,
  kind             text not null,              -- monthly | weekly
  side             text not null default 'buy',
  ticker           text not null,
  status           text not null,              -- open | alternate | filled | dropped | cancelled
  alt_order        integer,                    -- order among alternates (null for buys)
  comp_rank        integer,
  mom_pct          real,
  h52              real,
  days_since_high  integer,
  sector           text,
  sigma63          real,
  atr20            real,
  w                real,
  t_target         real,                       -- T
  s_close          real,                       -- S (reset on retry day 3 when the entry test still passes)
  cap              real,
  planned_shares   real,
  trade_date       date,                       -- the session this ticket is working
  retry_day        integer not null default 1,
  bid              real,
  ask              real,
  lp1              real,
  lp2              real,
  shares_lp1       real,
  shares_lp2       real,
  risk_cap_shares  real,
  quoted_at        timestamptz,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (signal_date, kind, side, ticker)
);
create index if not exists ss_mom_tickets_status_idx on public.ss_mom_tickets (status, trade_date);

create table if not exists public.ss_mom_lots (
  id               bigserial primary key,
  ticker           text not null,
  figi             text,
  ticket_id        bigint references public.ss_mom_tickets (id),
  signal_date      date,
  s_close          real,
  mom_pct          real,
  h52              real,
  days_since_high  integer,
  comp_rank        integer,
  sigma63          real,
  atr20            real,
  regime           text,
  b                real,
  e                real,
  i                real,
  n                integer,
  w                real,
  t_target         real,
  shares           real not null,
  risk_cap_shares  real,
  lp1              real,
  lp2              real,
  fill_price       real not null,              -- F
  filled_at        timestamptz not null,
  d                real not null,              -- stop distance, fixed for the life of the lot
  stop0            real not null,
  stop             real not null,              -- Stop_t (never lowered)
  highest_close    real,
  disaster_stop    real not null,
  earnings_date    date,
  lt_date          date not null,              -- entry date + 1 year + 1 calendar day
  exit_date        date,
  exit_trigger     integer,
  exit_price       real,
  fees             real,
  pnl              real,
  r_multiple       real,
  days_held        integer,
  term             text,                       -- ST | LT
  wash_sale        boolean,
  slippage_s_bps   real,
  slippage_lp_bps  real,
  rule_broken      boolean not null default false,
  rule_note        text,
  created_at       timestamptz not null default now()
);
create index if not exists ss_mom_lots_open_idx on public.ss_mom_lots (ticker) where exit_date is null;

alter table public.ss_mom_tickets enable row level security;
alter table public.ss_mom_lots enable row level security;
