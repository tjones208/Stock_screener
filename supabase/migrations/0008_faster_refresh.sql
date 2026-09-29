-- The indicator refresh took ~63s on 2.4M bars, far past the 8s API statement timeout, and the
-- app ignored the error, so the snapshot silently stopped updating (SMA 200 stayed empty).
-- 1) Faster refresh: a single window sort, more sort memory, and a 380-day window.
-- 2) Give service_role (the app's server key) a 5-minute statement timeout; PostgREST applies
--    the impersonated role's settings, so reload its config afterwards.

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
      max(vw) filter (where rn = 1) as vwap,
      max(h)  filter (where rn = 1) as day_high,
      max(l)  filter (where rn = 1) as day_low,
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
    day_open, day_high, day_low, updated_at
  )
  select ticker, as_of, close,
    case when prev_close > 0 then (close - prev_close) / prev_close * 100 end,
    case when prev_close > 0 then (open_ - prev_close) / prev_close * 100 end,
    volume, avg_vol20,
    case when avg_vol20 > 0 then volume / avg_vol20 end,
    sma20, sma50, sma200, sma50_prev, sma200_prev, sma9, sma21,
    case when n14 < 14 then null
         when losses14 = 0 then 100
         else 100 - 100 / (1 + gains14 / losses14) end,
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
    open_, day_high, day_low,
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
    updated_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter role service_role set statement_timeout = '300s';
notify pgrst, 'reload config';
