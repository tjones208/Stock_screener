# Wheel Screener

A personal stock screener for the **wheel strategy** (cash-secured puts → covered calls).
Next.js on Vercel Hobby + Supabase (`meal-plan-sync` project, tables prefixed `ss_`). $0 to run.

- **Screener:** 30 numeric filters (price, volume, technicals, fundamentals, wheel metrics) plus 13 conditions (above SMA 200, golden cross, near 52w low, …). Filters live in the URL, and you can save any filter set as a named screen.
- **Strategy presets:** pick a strategy (wheel, VWAP reversion, opening-range breakout, gap & go, NR7 squeeze, momentum, pullback, oversold bounce) to prefill filters and columns. Each row shows mechanical **entry / stop / target / R:R** levels from that strategy's rules (`lib/levels.ts`). They're based on end-of-day data and are a plan for the next session, not a prediction.
- **Wheel:** each night the app pulls put chains and ranks them by annualized yield, then IV, then low delta, then liquidity (OI and spread). Strikes are capped at $50, so collateral stays ≤ $5,000.
- **Ticker page:** candlestick chart ([TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)) with EMA21, SMA50/200 and the best put strike, plus technicals, fundamentals and put candidates.
- **Watchlists:** listed names always get their options scanned, get fundamentals first, and keep full price history.
- **Alerts:** price and RSI levels, SMA crosses, volume spikes, 52w highs/lows, gaps, put yield, and new matches for a saved screen. They're checked nightly and sent as Web Push to the installed app.

## Data sources

| What | Source | Notes |
|---|---|---|
| Daily bars (whole market) | Massive Stocks Basic (free) | `grouped daily`: 1 call/day for every ticker. 5 calls/min. |
| Fundamentals | Massive ticker details + financials | 2 tickers/min on a rolling schedule. Order: watchlist, then S&P 500, then the rest. Refreshed every 30 days. |
| Options | Alpaca paper account, `indicative` feed (free) | Quotes are delayed and modified, so treat premiums as approximate and **confirm in Robinhood**. |
| S&P 500 list + GICS sectors | [datasets/s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies) | Other tickers get a sector mapped from their SIC code. |

Earnings dates and dividend yield aren't available on the free tiers. Those columns stay empty, and "No earnings in next 30 days" passes when the date is unknown.

## Schedule (UTC, run by Supabase pg_cron → the app's `/api/cron/*` routes)

| Job | When | What |
|---|---|---|
| `ss-eod` | Tue–Sat 10:05 (≈ 6am ET) | Load the **previous** trading day's bars → recompute indicators → prune old bars. Massive's free plan won't serve a day's bars until well after the close, so this runs the next morning. Tuesdays also refresh the ticker list. |
| `ss-options` | Tue–Sat 10:25 (≈ 6:25am ET) | Scan put chains (top 150 liquid names under $50, plus watchlists), then evaluate alerts and send push before the open. |
| `ss-fundamentals` | every minute | 2 tickers per run. Waits until the backfill is done. |
| `ss-backfill` | every 6 min | Loads about 20 missing days per run, up to 400 days back. Once history is complete it does nothing. |

The cron token lives in the `ss_app_secrets` table, where both pg_cron and the app read it, so it never has to be copied anywhere. See the job log in `ss_job_runs` and the schedules with `select * from cron.job;`. The nightly writes also keep the free Supabase project from pausing.

## Setup

1. **Vercel project** `stock-screener` (Buckhorn team) is linked to this repo. Every push to `main` deploys to **https://stock-screener-five-ecru.vercel.app**.
2. **Environment variables** (Vercel → Settings → Environment Variables):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `MASSIVE_API_KEY`
   - `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` (paper account; only needed for options/wheel data)
   - `APP_PASSWORD`

   Nothing else is needed. The session key is derived from the service-role key, and the cron token and push keys live in `ss_app_secrets`.
3. **Migration 0003** creates the secrets table and the schedules above.
4. **Phone:** open the site in Safari → Share → **Add to Home Screen**. Open the app from the Home Screen → Alerts → **Enable notifications**.

## Development

```bash
npm install
cp .env.example .env.local   # fill in values; never commit it
npm run dev
npm test                     # wheel scoring, filters, alerts, indicators
```

Schema changes live in `supabase/migrations/`. All migrations are applied to `meal-plan-sync` by hand (Supabase SQL editor or MCP), in order.
