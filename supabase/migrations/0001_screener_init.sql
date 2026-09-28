-- Stock screener (wheel strategy) — initial schema
-- Lives in the shared `meal-plan-sync` project; every object is prefixed `ss_`.
-- RLS is enabled with no policies: only the service role (Vercel server code) can read/write.

-- ───────────────────────── Reference data ─────────────────────────
create table if not exists public.ss_tickers (
  ticker        text primary key,
  name          text,
  type          text,                 -- CS, ETF, ADRC, ...
  exchange      text,
  sector        text,
  industry      text,
  sic_code      text,
  market_cap    numeric,
  shares_out    numeric,
  in_sp500      boolean not null default false,
  has_options   boolean,              -- null = unknown yet
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);

-- End-of-day bars (Massive grouped daily). Pruned to ~400 days except watchlist names.
create table if not exists public.ss_daily_bars (
  ticker  text    not null,
  d       date    not null,
  o       real    not null,
  h       real    not null,
  l       real    not null,
  c       real    not null,
  v       bigint  not null,
  vw      real,
  n       integer,
  primary key (ticker, d)
);
create index if not exists ss_daily_bars_d_idx on public.ss_daily_bars (d);

-- Latest technical snapshot per ticker (recomputed nightly by ss_refresh_indicators()).
create table if not exists public.ss_indicators (
  ticker         text primary key,
  as_of          date not null,
  close          real,
  change_pct     real,
  gap_pct        real,
  volume         bigint,
  avg_vol20      real,
  vol_ratio      real,               -- today's volume / prior 20-day average
  sma20          real,
  sma50          real,
  sma200         real,
  sma50_prev     real,               -- prior-day values, for cross detection
  sma200_prev    real,
  ema9           real,               -- filled by app code (recursive)
  ema21          real,
  rsi14          real,               -- Cutler's RSI (simple-average)
  atr14          real,
  hv30           real,               -- 30-day annualized historical volatility
  high_52w       real,
  low_52w        real,
  pct_from_high  real,
  pct_from_low   real,
  bars           integer,            -- how much history backs these numbers
  updated_at     timestamptz not null default now()
);
create index if not exists ss_indicators_close_idx on public.ss_indicators (close);

-- Fundamentals (Massive financials / ticker details), fetched in rolling batches.
create table if not exists public.ss_fundamentals (
  ticker              text primary key references public.ss_tickers(ticker) on delete cascade,
  period_end          date,
  fiscal_period       text,
  revenue_ttm         numeric,
  revenue_growth_yoy  real,
  net_income_ttm      numeric,
  eps_ttm             real,
  pe                  real,
  ps                  real,
  pb                  real,
  gross_margin        real,
  operating_margin    real,
  net_margin          real,
  roe                 real,
  debt_to_equity      real,
  current_ratio       real,
  free_cash_flow_ttm  numeric,
  dividend_yield      real,
  next_earnings_date  date,
  raw                 jsonb,
  fetched_at          timestamptz not null default now()
);
create index if not exists ss_fundamentals_fetched_idx on public.ss_fundamentals (fetched_at);

-- ───────────────────────── Options (Alpaca indicative) ─────────────────────────
-- Short-put candidates captured by the nightly scan. Premiums are indicative/delayed.
create table if not exists public.ss_option_candidates (
  id              bigint generated always as identity primary key,
  as_of           date not null,
  ticker          text not null,
  contract        text not null,       -- OCC symbol
  side            text not null check (side in ('put','call')),
  expiration      date not null,
  dte             integer not null,
  strike          real not null,
  underlying      real,
  bid             real,
  ask             real,
  mid             real,
  last            real,
  iv              real,
  delta           real,
  theta           real,
  open_interest   integer,
  volume          integer,
  spread_pct      real,                -- (ask-bid)/mid
  otm_pct         real,                -- distance of strike from underlying
  collateral      real,                -- strike * 100
  annual_yield    real,                -- (mid / strike) * (365 / dte)
  score           real,                -- composite wheel rank
  unique (as_of, contract)
);
create index if not exists ss_option_candidates_rank_idx on public.ss_option_candidates (as_of, score desc);
create index if not exists ss_option_candidates_ticker_idx on public.ss_option_candidates (ticker, as_of);

-- ───────────────────────── User data ─────────────────────────
create table if not exists public.ss_watchlists (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.ss_watchlist_items (
  watchlist_id  bigint not null references public.ss_watchlists(id) on delete cascade,
  ticker        text   not null,
  notes         text,
  added_at      timestamptz not null default now(),
  primary key (watchlist_id, ticker)
);
create index if not exists ss_watchlist_items_ticker_idx on public.ss_watchlist_items (ticker);

-- Saved screens: filters stored as JSON so new filter types need no migration.
create table if not exists public.ss_screens (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  filters     jsonb not null default '{}'::jsonb,
  sort        jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Alert rules: kind = price_cross | rsi | sma_cross | volume_spike | new_52w | gap | screen_match | wheel_yield ...
create table if not exists public.ss_alert_rules (
  id          bigint generated always as identity primary key,
  name        text not null,
  kind        text not null,
  ticker      text,                    -- null = applies to a screen / watchlist / universe
  screen_id   bigint references public.ss_screens(id) on delete cascade,
  watchlist_id bigint references public.ss_watchlists(id) on delete cascade,
  params      jsonb not null default '{}'::jsonb,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.ss_alert_events (
  id            bigint generated always as identity primary key,
  rule_id       bigint not null references public.ss_alert_rules(id) on delete cascade,
  ticker        text not null,
  triggered_on  date not null,
  message       text not null,
  payload       jsonb,
  pushed_at     timestamptz,
  created_at    timestamptz not null default now(),
  unique (rule_id, ticker, triggered_on)   -- one alert per rule/ticker/day
);
create index if not exists ss_alert_events_recent_idx on public.ss_alert_events (created_at desc);

-- Web Push subscriptions (installable PWA).
create table if not exists public.ss_push_subscriptions (
  id          bigint generated always as identity primary key,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz
);

-- Job log (also doubles as the daily keep-alive write).
create table if not exists public.ss_job_runs (
  id           bigint generated always as identity primary key,
  job          text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','ok','error')),
  detail       jsonb
);
create index if not exists ss_job_runs_job_idx on public.ss_job_runs (job, started_at desc);

-- ───────────────────────── RLS (service role only) ─────────────────────────
alter table public.ss_tickers            enable row level security;
alter table public.ss_daily_bars         enable row level security;
alter table public.ss_indicators         enable row level security;
alter table public.ss_fundamentals       enable row level security;
alter table public.ss_option_candidates  enable row level security;
alter table public.ss_watchlists         enable row level security;
alter table public.ss_watchlist_items    enable row level security;
alter table public.ss_screens            enable row level security;
alter table public.ss_alert_rules        enable row level security;
alter table public.ss_alert_events       enable row level security;
alter table public.ss_push_subscriptions enable row level security;
alter table public.ss_job_runs           enable row level security;

-- ───────────────────────── Functions ─────────────────────────
-- Recompute ss_indicators from stored bars for tickers that traded on p_as_of.
create or replace function public.ss_refresh_indicators(p_as_of date default null)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_as_of date;
  v_count integer;
begin
  v_as_of := coalesce(p_as_of, (select max(d) from ss_daily_bars));
  if v_as_of is null then
    return 0;
  end if;

  with b as (
    select ticker, d, o, h, l, c, v,
           lag(c) over (partition by ticker order by d)            as prev_c,
           row_number() over (partition by ticker order by d desc) as rn
    from ss_daily_bars
    where d <= v_as_of and d > v_as_of - 400
  ),
  agg as (
    select ticker,
      max(d)                                                   filter (where rn = 1) as as_of,
      max(c)                                                   filter (where rn = 1) as close,
      max(o)                                                   filter (where rn = 1) as open_,
      max(prev_c)                                              filter (where rn = 1) as prev_close,
      max(v)                                                   filter (where rn = 1) as volume,
      avg(v)                                                   filter (where rn between 2 and 21) as avg_vol20,
      case when count(*) filter (where rn <= 20)  = 20  then avg(c) filter (where rn <= 20)  end as sma20,
      case when count(*) filter (where rn <= 50)  = 50  then avg(c) filter (where rn <= 50)  end as sma50,
      case when count(*) filter (where rn <= 200) = 200 then avg(c) filter (where rn <= 200) end as sma200,
      case when count(*) filter (where rn between 2 and 51)  = 50  then avg(c) filter (where rn between 2 and 51)  end as sma50_prev,
      case when count(*) filter (where rn between 2 and 201) = 200 then avg(c) filter (where rn between 2 and 201) end as sma200_prev,
      sum(greatest(c - prev_c, 0)) filter (where rn <= 14 and prev_c is not null) as gains14,
      sum(greatest(prev_c - c, 0)) filter (where rn <= 14 and prev_c is not null) as losses14,
      count(*) filter (where rn <= 14 and prev_c is not null)                        as n14,
      avg(greatest(h - l, abs(h - prev_c), abs(l - prev_c))) filter (where rn <= 14 and prev_c is not null) as atr14,
      stddev_samp(ln(c / nullif(prev_c, 0))) filter (where rn <= 30 and prev_c > 0 and c > 0) * sqrt(252) as hv30,
      max(h) filter (where rn <= 252) as high_52w,
      min(l) filter (where rn <= 252) as low_52w,
      count(*) as bars
    from b
    group by ticker
  )
  insert into ss_indicators as i (
    ticker, as_of, close, change_pct, gap_pct, volume, avg_vol20, vol_ratio,
    sma20, sma50, sma200, sma50_prev, sma200_prev, rsi14, atr14, hv30,
    high_52w, low_52w, pct_from_high, pct_from_low, bars, updated_at
  )
  select ticker, as_of, close,
    case when prev_close > 0 then (close - prev_close) / prev_close * 100 end,
    case when prev_close > 0 then (open_ - prev_close) / prev_close * 100 end,
    volume, avg_vol20,
    case when avg_vol20 > 0 then volume / avg_vol20 end,
    sma20, sma50, sma200, sma50_prev, sma200_prev,
    case when n14 < 14 then null
         when losses14 = 0 then 100
         else 100 - 100 / (1 + gains14 / losses14) end,
    atr14, hv30, high_52w, low_52w,
    case when high_52w > 0 then (close - high_52w) / high_52w * 100 end,
    case when low_52w  > 0 then (close - low_52w)  / low_52w  * 100 end,
    bars, now()
  from agg
  where as_of = v_as_of
  on conflict (ticker) do update set
    as_of = excluded.as_of, close = excluded.close, change_pct = excluded.change_pct,
    gap_pct = excluded.gap_pct, volume = excluded.volume, avg_vol20 = excluded.avg_vol20,
    vol_ratio = excluded.vol_ratio, sma20 = excluded.sma20, sma50 = excluded.sma50,
    sma200 = excluded.sma200, sma50_prev = excluded.sma50_prev, sma200_prev = excluded.sma200_prev,
    rsi14 = excluded.rsi14, atr14 = excluded.atr14, hv30 = excluded.hv30,
    high_52w = excluded.high_52w, low_52w = excluded.low_52w,
    pct_from_high = excluded.pct_from_high, pct_from_low = excluded.pct_from_low,
    bars = excluded.bars, updated_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Keep storage in budget: drop bars older than p_days unless the ticker is on a watchlist.
create or replace function public.ss_prune_bars(p_days integer default 400)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare v_count integer;
begin
  delete from ss_daily_bars b
  where b.d < current_date - p_days
    and not exists (select 1 from ss_watchlist_items w where w.ticker = b.ticker);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ───────────────────────── Views ─────────────────────────
-- Which tickers need fundamentals next: watchlist → S&P 500 → other sub-$50 names; stalest first.
create or replace view public.ss_fundamentals_queue
with (security_invoker = true) as
select t.ticker,
       case when exists (select 1 from ss_watchlist_items w where w.ticker = t.ticker) then 0
            when t.in_sp500 then 1
            else 2 end as priority,
       f.fetched_at
from ss_tickers t
join ss_indicators i on i.ticker = t.ticker
left join ss_fundamentals f on f.ticker = t.ticker
where t.active
  and t.type in ('CS', 'ADRC')
  and (i.close < 50 or exists (select 1 from ss_watchlist_items w where w.ticker = t.ticker))
  and (f.fetched_at is null or f.fetched_at < now() - interval '30 days')
order by priority, f.fetched_at nulls first, t.ticker;

-- One wide row per ticker for the screener UI; best put candidate from the latest scan.
create or replace view public.ss_screener
with (security_invoker = true) as
with latest as (select max(as_of) as as_of from ss_option_candidates),
best_put as (
  select distinct on (oc.ticker) oc.*
  from ss_option_candidates oc, latest
  where oc.as_of = latest.as_of and oc.side = 'put'
  order by oc.ticker, oc.score desc nulls last
)
select t.ticker, t.name, t.type, t.exchange, t.sector, t.industry, t.market_cap,
       t.in_sp500, t.has_options,
       i.as_of, i.close, i.change_pct, i.gap_pct, i.volume, i.avg_vol20, i.vol_ratio,
       i.sma20, i.sma50, i.sma200, i.sma50_prev, i.sma200_prev, i.ema9, i.ema21,
       i.rsi14, i.atr14, i.hv30, i.high_52w, i.low_52w, i.pct_from_high, i.pct_from_low,
       f.pe, f.ps, f.pb, f.eps_ttm, f.revenue_ttm, f.revenue_growth_yoy,
       f.gross_margin, f.operating_margin, f.net_margin, f.roe, f.debt_to_equity,
       f.current_ratio, f.free_cash_flow_ttm, f.dividend_yield, f.next_earnings_date,
       p.contract    as put_contract,
       p.expiration  as put_expiration,
       p.dte         as put_dte,
       p.strike      as put_strike,
       p.mid         as put_mid,
       p.iv          as put_iv,
       p.delta       as put_delta,
       p.open_interest as put_oi,
       p.spread_pct  as put_spread_pct,
       p.annual_yield as put_annual_yield,
       p.score       as wheel_score
from ss_tickers t
join ss_indicators i on i.ticker = t.ticker
left join ss_fundamentals f on f.ticker = t.ticker
left join best_put p on p.ticker = t.ticker;

-- Seed a default watchlist.
insert into public.ss_watchlists (name, sort_order) values ('Wheel candidates', 0)
on conflict (name) do nothing;
