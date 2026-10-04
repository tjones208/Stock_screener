# Backtests

Local backtests on Massive flat files. Runs on your own computer (or in Cowork / Claude Code on it);
nothing here touches Supabase or Vercel. The momentum strategy reuses the app's own rule functions
in `lib/momentum` (ranking, sizing, sector caps, stops, exits, regime band, volatility brake, wash
sales, long-term deferral, ticket retries), so results reflect what the live app would have done.

## Setup

Node 22.6+ (runs TypeScript directly).

```bash
cd backtest
npm install
npm test              # engine, metrics and an end-to-end run on synthetic data
npm run bt -- help
```

Try it without a subscription:

```bash
npm run bt -- synth --out data/synth --years 4 --stocks 300
npm run bt -- prepare --flat data/synth/flat --ref data/synth/ref --data data/synth/data
npm run bt -- run --data data/synth/data --strategy momentum
```

## Real data (Massive)

1. **Day aggregates (flat files).** In the Massive dashboard, open *Flat Files* to get the S3
   endpoint, bucket and access keys (separate from the API key). With the AWS CLI, something like:

   ```bash
   aws s3 sync s3://flatfiles/us_stocks_sip/day_aggs_v1/ ~/massive/day_aggs_v1/ --endpoint-url https://files.massive.com
   ```

   Check the dashboard for the exact endpoint and bucket. Each file is one trading day for the
   whole market (`YYYY/MM/YYYY-MM-DD.csv.gz`), including stocks that later delisted, so the
   data set is free of survivorship bias. Minute aggregates (`minute_aggs_v1`) use the same
   layout; download them later if a strategy needs intraday data (they're ~50× larger).

2. **Reference data** (splits, dividends, ticker list with delisted names, and SIC codes for
   sector caps). Put the API key in your environment, never in a file in the repo:

   ```bash
   export MASSIVE_API_KEY=…            # e.g. in your shell profile
   npm run bt -- fetch-ref --out ~/massive/ref --details --rps 20
   ```

   `--details` fetches one record per common stock (resumable if interrupted).

3. **Prepare** (one time, re-run when you add data):

   ```bash
   npm run bt -- prepare --flat ~/massive/day_aggs_v1 --ref ~/massive/ref --data ~/massive/bt --memory 8GB
   ```

   Writes split-adjusted bars plus features to `~/massive/bt/daily/year=YYYY/data.parquet`, and
   `tickers`, `dividends` and `calendar` parquet files. Features per ticker per day: returns over
   1/21/63/126/252 days, 12-1 momentum, SMA 20/50/200, 252-day high/low and days since the high,
   20/63/252-day volatility, ATR 14/20, 20-day average and 60-day median dollar volume.

## Running

```bash
# One run (+ SPY and MTUM buy-and-hold benchmarks)
npm run bt -- run --data ~/massive/bt --strategy momentum --from 2010-01-01 --to 2026-09-30 \
  --capital 20000 --slippage-bps 10 --set rank_method=classic --set n_max=20

# Parameter sweep: every combination, ranked by Sharpe (or --sort cagr / afterTaxCagr / calmar …)
npm run bt -- sweep --data ~/massive/bt --strategy momentum --from 2010-01-01 \
  --grid rank_method=classic,risk_adj --grid vol_scale=true,false --grid hold_rank_pct=0,0.2
```

Results go to `results/<timestamp>-…/`: `summary.json` (stats, parameters, benchmarks),
`equity.csv`, `trades.csv`, `fills.csv`; a sweep adds `sweep.csv` with one row per combination.

Options: `--where "c >= 5 and avg_dv20 >= 1e6"` loads only rows that pass (faster, less memory;
held names must pass it too or they look delisted); `--commission`, `--tax 0.30,0.15`,
`--bench SPY,MTUM,SPMO`.

### Execution model

Orders placed after a close work at the next session's open: buys at the open plus slippage, or
at a limit (fills at the open if it's under the limit, otherwise at the limit if the day's low
reaches it); sells at the open minus slippage. Dividends are paid in cash on ex-dates; holdings
that stop trading for 10 days are closed at their last close. Taxes: yearly short- and long-term
netting with loss carry-forward, dividends as ordinary income, plus tax on unrealized gains at the
end (after-tax CAGR).

### Momentum: what differs from live

No market-cap filter (price and dollar volume only: point-in-time market caps aren't in the flat
files), no earnings blackout, no buyout / pending-deal filter, no data-quality flags. B and E
follow the account's equity (`--set compound=false` keeps them fixed). Sectors come from SIC codes
(`fetch-ref --details`); without them every stock is its own sector bucket.

## Writing a strategy

Copy `src/strategies/topn.ts`, register it in `src/strategies/index.ts`. A strategy gets each
day's close (`ctx.today`: every ticker's row with the features above, `ctx.portfolio`,
`ctx.isMonthEnd`, …) and returns orders for the next open. It never sees future rows.

```ts
export const myStrategy: StrategyDef<{ n: number }> = {
  name: "my-strategy", description: "…", defaults: { n: 10 }, warmupDays: 0,
  create: (p) => ({
    onClose(ctx) {
      if (!ctx.trading || !ctx.isMonthEnd) return [];
      // … rank ctx.today, compare with ctx.portfolio.tickers(), return buys / sells
      return [];
    },
  }),
};
```
