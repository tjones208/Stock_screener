-- Oversold-bounce refactor.
-- * RSI(14) switches from Cutler's simple averages to Wilder's smoothing (the standard used by
--   TradingView/Robinhood). The refresh uses the closed-form exponential weights (fast, one pass);
--   ss_wilder_rsi() is the exact recursive aggregate kept to verify it. An ordered aggregate over
--   2.4M bars took > 2 minutes, too slow for the morning job.
-- * New snapshot fields: 10-day SMA (new oversold target), prior day's open/close (reversal candles).
-- * ss_loaded_days.full_universe tracks the one-time reload of bars above the old $75 cap.

-- Wilder state: {closes seen, previous close, avg gain, avg loss}.
-- Changes 1–14 are summed, divided by 14 at the 14th; afterwards avg = (avg × 13 + x) / 14.
create or replace function public.ss_wilder_rsi_step(s float8[], c float8)
returns float8[]
language sql
immutable
as $$
  select case
    when s is null then array[1, c, 0, 0]::float8[]
    else array[
      s[1] + 1,
      c,
      case when s[1] < 14 then s[3] + greatest(c - s[2], 0)
           when s[1] = 14 then (s[3] + greatest(c - s[2], 0)) / 14
           else (s[3] * 13 + greatest(c - s[2], 0)) / 14 end,
      case when s[1] < 14 then s[4] + greatest(s[2] - c, 0)
           when s[1] = 14 then (s[4] + greatest(s[2] - c, 0)) / 14
           else (s[4] * 13 + greatest(s[2] - c, 0)) / 14 end
    ]::float8[]
  end
$$;

create or replace function public.ss_wilder_rsi_final(s float8[])
returns float8
language sql
immutable
as $$
  select case
    when s is null or s[1] < 15 then null            -- needs 14 price changes
    when s[4] = 0 then case when s[3] = 0 then 50 else 100 end
    else 100 - 100 / (1 + s[3] / s[4])
  end
$$;

drop aggregate if exists public.ss_wilder_rsi(float8);
create aggregate public.ss_wilder_rsi(float8) (
  sfunc = public.ss_wilder_rsi_step,
  stype = float8[],
  finalfunc = public.ss_wilder_rsi_final
);

alter table public.ss_indicators
  add column if not exists sma10      real,
  add column if not exists prev_open  real,
  add column if not exists prev_close real;

alter table public.ss_loaded_days
  add column if not exists full_universe boolean not null default false;

create or replace function public.ss_refresh_indicators(p_as_of date default null)
returns integer
language plpgsql
security invoker
set search_path = public
set work_mem = '64MB'
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
    -- One window (newest first): lead() over a descending order is the previous day's close.
    select ticker, d, o, h, l, c, v, vw,
           lead(c)      over w as prev_c,
           row_number() over w as rn
    from ss_daily_bars
    where d <= v_as_of and d > v_as_of - 380   -- 380 calendar days ≈ 255 trading days (≥ 252 for the 52w range)
    window w as (partition by ticker order by d desc)
  ),
  agg as (
    select ticker,
      max(d)                                                   filter (where rn = 1) as as_of,
      max(c)                                                   filter (where rn = 1) as close,
      max(o)                                                   filter (where rn = 1) as open_,
      max(prev_c)                                              filter (where rn = 1) as prev_close,
      max(v)                                                   filter (where rn = 1) as volume,
      avg(v)                                                   filter (where rn between 2 and 21) as avg_vol20,
      case when count(*) filter (where rn <= 9)   = 9   then avg(c) filter (where rn <= 9)   end as sma9,
      case when count(*) filter (where rn <= 21)  = 21  then avg(c) filter (where rn <= 21)  end as sma21,
      case when count(*) filter (where rn <= 10)  = 10  then avg(c) filter (where rn <= 10)  end as sma10,
      case when count(*) filter (where rn <= 20)  = 20  then avg(c) filter (where rn <= 20)  end as sma20,
      case when count(*) filter (where rn <= 50)  = 50  then avg(c) filter (where rn <= 50)  end as sma50,
      case when count(*) filter (where rn <= 200) = 200 then avg(c) filter (where rn <= 200) end as sma200,
      case when count(*) filter (where rn between 2 and 51)  = 50  then avg(c) filter (where rn between 2 and 51)  end as sma50_prev,
      case when count(*) filter (where rn between 2 and 201) = 200 then avg(c) filter (where rn between 2 and 201) end as sma200_prev,
      -- Wilder's RSI(14) = exponential smoothing with α = 1/14, i.e. avg = Σ (1/14)(13/14)^j · x_j.
      -- Summing the last 150 changes with those weights equals the recursive result to ~1e-5
      -- (the dropped tail weighs (13/14)^150); the 1/14 factor cancels in the gain/loss ratio.
      -- One pass, no per-row function calls. ss_wilder_rsi() above is the exact recursive
      -- reference used to verify it.
      sum(greatest(c - prev_c, 0)::float8 * power(13.0::float8 / 14, (rn - 1)::float8))
        filter (where rn <= 150 and prev_c is not null)        as wilder_gain,
      sum(greatest(prev_c - c, 0)::float8 * power(13.0::float8 / 14, (rn - 1)::float8))
        filter (where rn <= 150 and prev_c is not null)        as wilder_loss,
      count(*) filter (where prev_c is not null)               as n_changes,
      avg(greatest(h - l, abs(h - prev_c), abs(l - prev_c))) filter (where rn <= 14 and prev_c is not null) as atr14,
      stddev_samp(ln(c / nullif(prev_c, 0))) filter (where rn <= 30 and prev_c > 0 and c > 0) * sqrt(252) as hv30,
      max(h) filter (where rn <= 252) as high_52w,
      min(l) filter (where rn <= 252) as low_52w,
      max(vw) filter (where rn = 1) as vwap,
      max(h)  filter (where rn = 1) as day_high,
      max(l)  filter (where rn = 1) as day_low,
      max(o)  filter (where rn = 2) as prev_open,
      max(h)  filter (where rn = 2) as prev_high,
      max(l)  filter (where rn = 2) as prev_low,
      max(c)  filter (where rn = 6)  as close_5d_ago,
      max(c)  filter (where rn = 21) as close_20d_ago,
      min(h - l) filter (where rn <= 7) as min_range7,
      count(*) filter (where rn <= 7)   as n7,
      count(*) as bars
    from b
    group by ticker
  )
  insert into ss_indicators as i (
    ticker, as_of, close, change_pct, gap_pct, volume, avg_vol20, vol_ratio,
    sma20, sma50, sma200, sma50_prev, sma200_prev, ema9, ema21, rsi14, atr14, hv30,
    high_52w, low_52w, pct_from_high, pct_from_low, bars,
    vwap, range_pos, change_5d, change_20d, nr7, inside_day,
    day_open, day_high, day_low, sma10, prev_open, prev_close, updated_at
  )
  select ticker, as_of, close,
    case when prev_close > 0 then (close - prev_close) / prev_close * 100 end,
    case when prev_close > 0 then (open_ - prev_close) / prev_close * 100 end,
    volume, avg_vol20,
    case when avg_vol20 > 0 then volume / avg_vol20 end,
    sma20, sma50, sma200, sma50_prev, sma200_prev, sma9, sma21,
    case when n_changes < 14 then null
         when wilder_loss = 0 then case when wilder_gain = 0 then 50 else 100 end
         else 100 - 100 / (1 + wilder_gain / wilder_loss) end,
    atr14, hv30, high_52w, low_52w,
    case when high_52w > 0 then (close - high_52w) / high_52w * 100 end,
    case when low_52w  > 0 then (close - low_52w)  / low_52w  * 100 end,
    bars,
    vwap,
    case when day_high > day_low then (close - day_low) / (day_high - day_low) * 100 end,
    case when close_5d_ago  > 0 then (close - close_5d_ago)  / close_5d_ago  * 100 end,
    case when close_20d_ago > 0 then (close - close_20d_ago) / close_20d_ago * 100 end,
    case when n7 = 7 then (day_high - day_low) <= min_range7 end,
    case when prev_high is not null then day_high < prev_high and day_low > prev_low end,
    open_, day_high, day_low, sma10, prev_open, prev_close,
    now()
  from agg
  where as_of = v_as_of
  on conflict (ticker) do update set
    as_of = excluded.as_of, close = excluded.close, change_pct = excluded.change_pct,
    gap_pct = excluded.gap_pct, volume = excluded.volume, avg_vol20 = excluded.avg_vol20,
    vol_ratio = excluded.vol_ratio, sma20 = excluded.sma20, sma50 = excluded.sma50,
    sma200 = excluded.sma200,
    -- EMA steps forward from yesterday's stored value; seeded with the SMA the first time.
    ema9 = case when i.as_of < excluded.as_of and i.ema9 is not null
                then excluded.close * 0.2 + i.ema9 * 0.8
                when i.as_of = excluded.as_of then coalesce(i.ema9, excluded.ema9)
                else excluded.ema9 end,
    ema21 = case when i.as_of < excluded.as_of and i.ema21 is not null
                 then excluded.close * (2.0 / 22) + i.ema21 * (20.0 / 22)
                 when i.as_of = excluded.as_of then coalesce(i.ema21, excluded.ema21)
                 else excluded.ema21 end,
    sma50_prev = excluded.sma50_prev, sma200_prev = excluded.sma200_prev,
    rsi14 = excluded.rsi14, atr14 = excluded.atr14, hv30 = excluded.hv30,
    high_52w = excluded.high_52w, low_52w = excluded.low_52w,
    pct_from_high = excluded.pct_from_high, pct_from_low = excluded.pct_from_low,
    bars = excluded.bars, vwap = excluded.vwap, range_pos = excluded.range_pos,
    change_5d = excluded.change_5d, change_20d = excluded.change_20d,
    nr7 = excluded.nr7, inside_day = excluded.inside_day,
    day_open = excluded.day_open, day_high = excluded.day_high, day_low = excluded.day_low,
    sma10 = excluded.sma10, prev_open = excluded.prev_open, prev_close = excluded.prev_close,
    updated_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

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
       p.score       as wheel_score,
       i.vwap, i.range_pos, i.change_5d, i.change_20d, i.nr7, i.inside_day,
       i.day_open, i.day_high, i.day_low,
       i.sma10, i.prev_open, i.prev_close
from ss_tickers t
join ss_indicators i on i.ticker = t.ticker
left join ss_fundamentals f on f.ticker = t.ticker
left join best_put p on p.ticker = t.ticker;
