# Stock Screener

A personal stock screener with day/swing strategy presets and a monthly **momentum** strategy. You buy and sell in your broker (Robinhood) and record trades here.
Next.js on Vercel Hobby + Supabase (`meal-plan-sync` project, tables prefixed `ss_`). $0 to run.

- **Screener:** numeric filters (price, volume, technicals, fundamentals) plus 13 conditions (above SMA 200, golden cross, near 52w low, …). Filters live in the URL, and you can save any filter set as a named screen.
- **Strategy presets:** pick a strategy (VWAP reversion, opening-range breakout, gap & go, NR7 squeeze, momentum, pullback, oversold bounce) to prefill filters and columns. Each row shows mechanical **entry / stop / target / R:R** levels from that strategy's rules (`lib/levels.ts`). They're based on end-of-day data and are a plan for the next session, not a prediction.
- **Pullback in an uptrend (swing):** close above the 50- and 200-day SMA, a rising 20 EMA above the 50 SMA, the lowest Wilder RSI of the last 5 sessions in 40–50, a support test by the 5-day pullback low (20 EMA, 50 SMA or prior breakout level, within 0.25 ATR) with today's close holding, a daily confirmation candle today (hammer, engulfing or a close back above the 20 EMA after trading below it) on above-average volume, stocks/ADRs only (ETFs excluded), and SPY above its 200-day. Plan: buy-stop above the candle's high with a limit 0.25 ATR higher, stop 0.5 ATR under the 5-day swing low, sell 50% at the prior 20-day high (T1), trail the rest on the 20 EMA. Setups under 2:1 to T1 are hidden; risk is capped at 1%. Daily data only; the 1-hour execution chart isn't available.
- **Oversold bounce (swing):** Wilder RSI(14) ≤ 30, down ≥ 5% in 5 days, above the 200-day, ATR ≤ 12%, a bullish reversal candle (green / hammer / engulfing), no earnings within 5 trading days (flagged "unknown" when no date is available), and only while SPY is above its 200-day. Plans are market-on-open T+1 inside a gap band (close − 1 ATR to close + 0.5 ATR), with the stop at close − 1.5 ATR, the target at the 10-day SMA (or + 1.5 ATR) and a 5-trading-day time exit. Sizing: 0.5% risk off the worst allowed fill, ≤ 15% of equity and ≤ 0.10% of average volume (these only tighten your own settings).
- **Momentum (monthly rotation, in progress):** the Momentum tab ranks liquid common stocks (≥ $10, ≥ $2B market cap, ≥ $20M median 60-day dollar volume, ≥ 273 days of clean history, no acquisition-agreement news, no open data flags) by 12-1 month momentum and closeness to the 52-week high, with entry/hold tests and an SPY 10-month-SMA regime filter. A full ranking snapshot is saved each week- and month-end. Data checks flag missing days, zero volume, > 40% one-day moves with no split, and splits whose stored bars still need a re-fetch; blocking flags stay until you clear them. All settings live on the page (same keys as the spec). Position sizing (inverse-volatility weights, risk cap, sector caps) builds the buy list; the morning after a week- or month-end signal the app opens buy tickets: enter the 9:45 bid/ask to get LP1/LP2 and shares, record fills (D, Stop0, disaster stop, long-term date), and unfilled tickets roll forward with the retry rules. Each night open lots trail their stop (max of the previous stop and highest close − D, never lower) and disaster stop (stop − ½D; the page lists Friday GTC updates), then the exit review creates sell tickets in the spec's trigger order (month-end regime, stop hit, month-end hold test, acquisition news, halt/delisting, month-end trim over 2× target) plus month-end top-ups; enter the 9:45 bid/ask for XP1/XP2 and record exits (P&L, R, days held, ST/LT). Covered calls (optional, on by default): you sell calls in Robinhood on positions already holding 100+ shares and record them; the app shows which positions qualify and the expiration window (before the next month-end rebalance and before earnings), with a 0.15–0.20 delta guideline; exits prompt you to buy back calls first, expired calls settle automatically and an in-the-money expiry asks you to confirm the shares were called away (an exit at the strike). Positions can also be added by hand with "+ Add" (rule breaks are flagged). Tax rules, buying-power changes and the journal reports are the next build steps.
- **Ticker page:** candlestick chart ([TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)) with EMA21, SMA50/200, plus technicals and fundamentals.
- **Watchlists:** listed names get fundamentals first and keep full price history.
- **Alerts:** price and RSI levels, SMA crosses, volume spikes, 52w highs/lows, gaps, and new matches for a saved screen. They're checked nightly and sent as Web Push to the installed app.

## Data sources

| What | Source | Notes |
|---|---|---|
| Daily bars (whole market) | Massive Stocks Basic (free) | `grouped daily`: 1 call/day for every ticker. 5 calls/min. Common stocks, ETFs and ADRs priced ≥ $1, no upper price cap. RSI is Wilder's. |
| Fundamentals | Massive ticker details + financials | 2 tickers/min on a rolling schedule. Order: watchlist, then S&P 500, then the rest. Refreshed every 30 days. |
| S&P 500 list + GICS sectors | [datasets/s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies) | Other tickers get a sector mapped from their SIC code. |

Earnings dates and dividend yield aren't available on the free tiers. Those columns stay empty, and "No earnings in next 30 days" passes when the date is unknown.

## Schedule (UTC, run by Supabase pg_cron → the app's `/api/cron/*` routes)

| Job | When | What |
|---|---|---|
| `ss-eod` | Tue–Sat 10:05 (≈ 6am ET) | Load the **previous** trading day's bars → recompute indicators → prune old bars. Massive's free plan won't serve a day's bars until well after the close, so this runs the next morning. |
| `ss-tickers` | Sun 12:05 | Refresh the ticker list and S&P 500 membership (~3 min at the free rate limit). |
| `ss-alerts` | Tue–Sat 10:25 (≈ 6:25am ET) | Evaluate alert rules on the previous close and send push before the open. |
| `ss-fundamentals` | every minute | 2 tickers per run. Waits until the backfill is done. |
| `ss-momentum` | Tue–Sat 10:15 | Sync splits and re-fetch bars for split tickers, then validation, universe, signals, ranking snapshot and regime for the latest trading day. |
| `ss-momentum-notify` | Mon–Fri 11:45 (≈ 7:45am ET) | Push today's momentum sells and why (stop hit, dropped off / failed hold test, regime, buyout, halt, trim), or "no sells". Skips market holidays. |
| `ss-backfill` | every 6 min | Loads about 20 missing days per run, up to 400 days back. Once history is complete it does nothing. |

The cron token lives in the `ss_app_secrets` table, where both pg_cron and the app read it, so it never has to be copied anywhere. See the job log in `ss_job_runs` and the schedules with `select * from cron.job;`. The nightly writes also keep the free Supabase project from pausing.

## Setup

1. **Vercel project** `stock-screener` (Buckhorn team) is linked to this repo. Every push to `main` deploys to **https://stock-screener-five-ecru.vercel.app**.
2. **Environment variables** (Vercel → Settings → Environment Variables):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `MASSIVE_API_KEY`
   - `APP_PASSWORD`

   Nothing else is needed. The session key is derived from the service-role key, and the cron token and push keys live in `ss_app_secrets`.
3. **Migration 0003** creates the secrets table and the schedules above.
4. **Phone:** open the site in Safari → Share → **Add to Home Screen**. Open the app from the Home Screen → Alerts → **Enable notifications**.

## Development

```bash
npm install
cp .env.example .env.local   # fill in values; never commit it
npm run dev
npm test                     # filters, strategies, alerts, indicators, momentum rules
```

Schema changes live in `supabase/migrations/`. All migrations are applied to `meal-plan-sync` by hand (Supabase SQL editor or MCP), in order.
