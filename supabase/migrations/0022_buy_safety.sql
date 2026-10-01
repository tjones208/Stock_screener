-- Buy safety: earnings-unchecked flag on tickets, per-run data-quality record, and the blackout
-- widened to 5 trading days. (0021 is the GICS sector migration, already applied.)

alter table public.ss_mom_tickets add column if not exists earnings_unchecked boolean not null default false;
alter table public.ss_mom_runs add column if not exists quality jsonb;

-- Data-quality inputs for signal date p_t: liquid names with no market cap (same rule as the build's
-- warning: CS on NYSE/Nasdaq/NYSE American, close ≥ min price, avg $ volume ≥ half the floor) and
-- news-sweep coverage of the last 90 calendar days.
create or replace function public.ss_mom_quality(p_t date, p_min_price real, p_min_dv float8)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'no_mcap', (select count(*) from ss_tickers t
                join ss_daily_bars b on b.ticker = t.ticker and b.d = p_t
                join ss_indicators i on i.ticker = t.ticker
                where t.active and t.type = 'CS' and t.exchange in ('XNYS', 'XNAS', 'XASE')
                  and b.c >= p_min_price and t.market_cap is null and i.avg_vol20 * i.close >= p_min_dv / 2),
    'news_days', (select count(*) from ss_news_days where d > p_t - 90)
  )
$$;

-- Backfill runs made before this column existed, from the counts their own build wrote into
-- `warnings` (absent warning = 0 missing / full news coverage). 9/28 shows 1,563 missing market caps
-- (fails the check, so it is never a universe baseline); 9/29 shows 4 (passes).
update public.ss_mom_runs r set quality = jsonb_build_object(
  'universe', (r.funnel -> -1 ->> 'count')::int,
  'no_mcap', coalesce((select (regexp_match(w, '^(\d+) stocks have no market cap'))[1]::int
                       from jsonb_array_elements_text(r.warnings) w where w ~ '^\d+ stocks have no market cap' limit 1), 0),
  'news_days', coalesce((select (regexp_match(w, 'covers (\d+) of the last 90'))[1]::int
                         from jsonb_array_elements_text(r.warnings) w where w ~ 'covers \d+ of the last 90' limit 1), 90),
  'backfilled', true
)
where r.quality is null;

-- Settings row overrides code defaults: widen the earnings blackout to 5 trading days.
update public.ss_settings set value = jsonb_set(value, '{earnings_blackout_days}', '5'::jsonb), updated_at = now()
where key = 'momentum';
