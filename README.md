# Wheel Screener

A personal stock screener for the **wheel strategy** (cash-secured puts → covered calls).
Next.js on Vercel Hobby + Supabase (`meal-plan-sync` project, tables prefixed `ss_`). $0 to run.

- **Screener:** 30 numeric filters (price, volume, technicals, fundamentals, wheel metrics) plus 13 conditions (above SMA 200, golden cross, near 52w low, …). Filters live in the URL, and you can save any filter set as a named screen.
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

## Schedule (UTC)

| Job | When | What |
|---|---|---|
| `/api/cron/eod` | Mon–Fri 22:05 (≈ 6pm ET) | Load today's bars → recompute indicators → prune old bars. On Mondays it also refreshes the ticker list. |
| `/api/cron/options` | Tue–Sat 00:05 (≈ 8pm ET) | Scan put chains (top 150 liquid names under $50, plus watchlists), then evaluate alerts and send push. |
| `/api/cron/fundamentals` | every minute (pg_cron) | 2 tickers per run. |
| `/api/cron/backfill` | manual / pg_cron until done | Loads about 20 missing days per call, up to 400 days back. |

Vercel Hobby crons fire somewhere within the scheduled hour. The nightly writes also keep the free Supabase project from pausing.

## Setup

1. **Vercel → Add New Project →** import this repo (framework: Next.js, no build settings needed).
2. **Environment variables** (Project → Settings → Environment Variables). The names are in `.env.example`:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API keys → `service_role`)
   - `MASSIVE_API_KEY`
   - `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` (paper account)
   - `APP_PASSWORD` (your login), `SESSION_SECRET` (any long random string)
   - `CRON_SECRET` (any long random string; Vercel sends it to the cron routes)
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (generate once with `npx web-push generate-vapid-keys`)
3. **Deploy**, then open the site and sign in.
4. **Backfill history** (about 15 runs of 5 minutes each). Either call it by hand:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>.vercel.app/api/cron/backfill`
   until `remaining` is 0, or let the pg_cron job in step 6 handle it.
5. **Phone:** open the site in Safari → Share → **Add to Home Screen**. Open the app from the Home Screen → Alerts → **Enable notifications**.
6. **pg_cron** (fundamentals every minute, plus backfill): run `supabase/migrations/0003_pg_cron.sql` once. First replace the URL, and store `CRON_SECRET` in Vault as described in that file.

## Development

```bash
npm install
cp .env.example .env.local   # fill in values; never commit it
npm run dev
npm test                     # wheel scoring, filters, alerts, indicators
```

Schema changes live in `supabase/migrations/`. `0001` and `0002` are already applied to `meal-plan-sync`; `0003` runs after the first deploy.
