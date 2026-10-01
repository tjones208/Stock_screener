-- Pending deals: a ticker stays out of entry and hold from its first definitive-agreement /
-- merger headline until a deal-closed or deal-terminated headline appears, or the deal is cleared
-- by hand. Events come from the news sweep (now 12 months back) and per-ticker news checks; the
-- deal state is recomputed from all events (lib/momentum/news.ts dealState), so the order the
-- sweep finds them in doesn't matter.

create table if not exists public.ss_deal_events (
  ticker     text not null,
  d          date not null,
  kind       text not null check (kind in ('open', 'closed', 'terminated')),
  headline   text not null,
  url        text,
  source     text not null default 'news',  -- news | ticker_news | flag
  created_at timestamptz not null default now(),
  primary key (ticker, d, kind, headline)
);
alter table public.ss_deal_events enable row level security;

create table if not exists public.ss_pending_deals (
  ticker       text primary key,
  opened_d     date not null,
  headline     text not null,
  url          text,
  status       text not null check (status in ('open', 'closed', 'terminated', 'cleared')),
  ended_d      date,
  end_headline text,
  cleared_at   timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.ss_pending_deals enable row level security;

-- Days already swept before deal tracking get re-read once for deal headlines.
alter table public.ss_news_days add column if not exists deals_scanned boolean not null default false;

-- Per-ticker news checks (tickets, alternates, holdings, top of the ranking), 12 months back.
create table if not exists public.ss_deal_ticker_scans (
  ticker     text primary key,
  scanned_at timestamptz not null default now()
);
alter table public.ss_deal_ticker_scans enable row level security;

-- Seed from the acquisition headlines already stored as buyout_news flags.
insert into ss_deal_events (ticker, d, kind, headline, source)
select f.ticker, f.d, 'open', coalesce(f.detail, 'Acquisition-agreement news'), 'flag'
from ss_data_flags f where f.kind = 'buyout_news'
on conflict do nothing;
insert into ss_pending_deals (ticker, opened_d, headline, status, cleared_at)
select distinct on (e.ticker) e.ticker, e.d, e.headline,
       case when f.cleared then 'cleared' else 'open' end, case when f.cleared then f.cleared_at end
from ss_deal_events e join ss_data_flags f on f.ticker = e.ticker and f.d = e.d and f.kind = 'buyout_news'
order by e.ticker, e.d
on conflict (ticker) do nothing;

-- Open deals fail entry and hold: the app marks those snapshot rows right after each build
-- (lib/momentum/jobs.ts applyPendingDeals), so ss_mom_build itself is unchanged.
