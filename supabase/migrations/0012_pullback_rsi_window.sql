-- Pullback logic fixes: the RSI rule is about the pullback, not the confirmation day, so store the
-- lowest Wilder RSI(14) of the last 5 sessions (closed form at offsets 0–4; derived from existing bars).

alter table public.ss_indicators add column if not exists rsi_min5 real;

create or replace function public.ss_rsi_from(g float8, l float8)
returns float8
language sql
immutable
as $$
  select case when g is null or l is null then null
              when l = 0 then case when g = 0 then 50 else 100 end
              else 100 - 100 / (1 + g / l) end
$$;

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
      -- Wilder RSI as of 1–4 bars ago (same closed form, shifted), for the lowest RSI of the last 5 sessions.
      sum(greatest(c - prev_c, 0)::float8 * power(13.0::float8 / 14, (rn - 2)::float8))
        filter (where rn between 2 and 151 and prev_c is not null) as wg1,
      sum(greatest(prev_c - c, 0)::float8 * power(13.0::float8 / 14, (rn - 2)::float8))
        filter (where rn between 2 and 151 and prev_c is not null) as wl1,
      sum(greatest(c - prev_c, 0)::float8 * power(13.0::float8 / 14, (rn - 3)::float8))
        filter (where rn between 3 and 152 and prev_c is not null) as wg2,
      sum(greatest(prev_c - c, 0)::float8 * power(13.0::float8 / 14, (rn - 3)::float8))
        filter (where rn between 3 and 152 and prev_c is not null) as wl2,
      sum(greatest(c - prev_c, 0)::float8 * power(13.0::float8 / 14, (rn - 4)::float8))
        filter (where rn between 4 and 153 and prev_c is not null) as wg3,
      sum(greatest(prev_c - c, 0)::float8 * power(13.0::float8 / 14, (rn - 4)::float8))
        filter (where rn between 4 and 153 and prev_c is not null) as wl3,
      sum(greatest(c - prev_c, 0)::float8 * power(13.0::float8 / 14, (rn - 5)::float8))
        filter (where rn between 5 and 154 and prev_c is not null) as wg4,
      sum(greatest(prev_c - c, 0)::float8 * power(13.0::float8 / 14, (rn - 5)::float8))
        filter (where rn between 5 and 154 and prev_c is not null) as wl4,
      -- EMA(20), α = 2/21, in closed form: Σ w·c / Σ w with w = (19/21)^age over the last 150 bars
      -- (the dropped tail weighs (19/21)^150 ≈ 3e-7). ema20_5d is the same average as of 5 bars ago.
      sum(c::float8 * power(19.0::float8 / 21, (rn - 1)::float8)) filter (where rn <= 150)
        / nullif(sum(power(19.0::float8 / 21, (rn - 1)::float8)) filter (where rn <= 150), 0)          as ema20,
      sum(c::float8 * power(19.0::float8 / 21, (rn - 6)::float8)) filter (where rn between 6 and 155)
        / nullif(sum(power(19.0::float8 / 21, (rn - 6)::float8)) filter (where rn between 6 and 155), 0) as ema20_5d,
      min(l) filter (where rn <= 5)             as swing_low5,     -- recent pullback low (incl. today)
      max(h) filter (where rn between 2 and 20) as swing_high20,   -- prior swing high before today
      max(h) filter (where rn between 21 and 60) as resistance60,  -- prior breakout level (horizontal support)
      count(*) filter (where rn <= 20)          as n20,
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
    day_open, day_high, day_low, sma10, prev_open, prev_close,
    ema20, ema20_5d, swing_low5, swing_high20, resistance60, rsi_min5, updated_at
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
    case when n20 = 20 then ema20 end, case when bars >= 25 then ema20_5d end,
    swing_low5, swing_high20, resistance60,
    case when n_changes >= 18 then least(
      ss_rsi_from(wilder_gain, wilder_loss), ss_rsi_from(wg1, wl1), ss_rsi_from(wg2, wl2),
      ss_rsi_from(wg3, wl3), ss_rsi_from(wg4, wl4)) end,
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
    ema20 = excluded.ema20, ema20_5d = excluded.ema20_5d, swing_low5 = excluded.swing_low5,
    swing_high20 = excluded.swing_high20, resistance60 = excluded.resistance60,
    rsi_min5 = excluded.rsi_min5,
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
       i.sma10, i.prev_open, i.prev_close,
       i.ema20, i.ema20_5d, i.swing_low5, i.swing_high20, i.resistance60,
       i.rsi_min5
from ss_tickers t
join ss_indicators i on i.ticker = t.ticker
left join ss_fundamentals f on f.ticker = t.ticker
left join best_put p on p.ticker = t.ticker;
