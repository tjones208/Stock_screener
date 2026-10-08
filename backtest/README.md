# Backtests

Local backtests on Massive flat files. Runs on your own computer (or in Cowork / Claude Code on it);
nothing here touches Supabase or Vercel. The momentum strategy reuses the app's own rule functions
in `lib/momentum` (ranking, sizing, sector caps, stops, exits, regime band, volatility brake, wash
sales, long-term deferral, ticket retries), so results reflect what the live app would have done.

## The app (Windows)

A local app that runs in your browser: set up your data, pick strategies, run backtests and
sweeps, and browse the results with charts. Everything stays on your computer.

1. Install **Node.js** (LTS, version 22 or newer) from <https://nodejs.org>.
2. Get the code: `git clone https://github.com/tjones208/Stock_screener.git` (or download the
   ZIP from GitHub and unzip it).
3. Open the `Stock_screener\backtest` folder and double-click **Start Backtester.bat**. The first
   start installs its components (about a minute); then the app opens at <http://localhost:5178>.
   Keep the black window open while you use it; close it to stop the app. Tip: right-click the
   .bat file → *Send to* → *Desktop (create shortcut)*.
4. **Update Backtester.bat** downloads the latest version (needs the git clone); your folders,
   presets, data and results are kept.

In the app:

- **Data**: paste your folder paths, save your Massive API key (kept in `backtest\.env`), then
  1) convert the downloads to Parquet, 2) download reference data, 3) prepare. *Try demo data*
  builds a synthetic market so you can explore before your data is ready.
- **Strategies**: the library lists the built-in strategies and every file in
  `backtest\strategies\` (see *Writing a strategy*; click *Reload* after adding one). Tick the
  ones to run, adjust settings (changed values are highlighted), turn on *Show sweep boxes* to
  test several values of a setting, and save settings as presets. *Start backtest* runs
  everything ticked as one batch.
- **Jobs**: live progress and logs; jobs run one at a time and can be cancelled.
- **Results**: every batch; a batch compares its runs (equity curves vs SPY / MTUM, sortable
  stats); a run shows its stats, equity and drawdown charts, settings and trades. *Open folder*
  shows the files (CSV / JSON) in File Explorer.

## Setup (command line)

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

2. **Convert to Parquet** (optional but recommended: about 3–5× smaller than the CSVs and much
   faster to read). Works for any Massive flat-file dataset (day or minute aggregates, trades,
   quotes) and is incremental, so re-run it after each download and only new days are converted:

   ```bash
   npm run bt -- convert --src ~/massive/day_aggs_v1    --dest ~/massive/parquet/day_aggs
   npm run bt -- convert --src ~/massive/minute_aggs_v1 --dest ~/massive/parquet/minute_aggs
   ```

   Columns are kept as delivered (prices unadjusted) plus `d` (trading day) and, for aggregates,
   `ts` (bar start, UTC). Small daily files are grouped one Parquet per month
   (`year=YYYY/month=MM/data.parquet`); large ones such as minute bars stay one per day
   (`year=YYYY/month=MM/YYYY-MM-DD.parquet`). `--group month|day` overrides, `--force` rebuilds.
   Query them directly with DuckDB, e.g.
   `select * from read_parquet('~/massive/parquet/minute_aggs/**/*.parquet') where ticker = 'AAPL' and d = '2024-01-03'`.
   You can delete the CSVs after converting, or keep them as the original copy.

3. **Reference data** (splits, dividends, ticker list with delisted names, and SIC codes for
   sector caps). Put the API key in your environment, never in a file in the repo:

   ```bash
   export MASSIVE_API_KEY=…            # e.g. in your shell profile
   npm run bt -- fetch-ref --out ~/massive/ref --details --rps 20
   ```

   `--details` fetches one record per common stock (resumable if interrupted).

4. **Prepare** (re-run when you add data). `--flat` takes either the CSV folder or its Parquet copy:

   ```bash
   npm run bt -- prepare --flat ~/massive/parquet/day_aggs --ref ~/massive/ref --data ~/massive/bt --memory 8GB
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

### Momentum pullback (`pullback`)

A swing strategy: liquid stock in an uptrend (close > 50-day > 200-day average), relative strength
in the top 25%, a pullback in the last 5 days (touched the 20-day average or 2+ down closes), then a
close above the prior day's high, while SPY is above its 50-day average (`market_ma`). Buys at the
next open sized to risk 0.75% of equity, with a swing-low stop, a 2R target, an exit after a close
under the 20-day average and a 15-day time stop. Every setting is in the app (same names as the
Python `Params`, plus `market_ma`); set capital and slippage on the run. Matches the original
Python trade for trade with `rs_universe = all` and `market_ma = 200` (the Python filtered on the
200-day); the default `liquid` ranks relative strength among tradable stocks only.

## Writing a strategy

Put a `.ts` file in `backtest/strategies/` (copy `strategies/example-low-vol.ts` or
`src/strategies/topn.ts`); it appears in the app's library and in `bt list` automatically. Add
`fields` to give its settings labels and groups in the app. A strategy gets each
day's close (`ctx.today`: every ticker's row with the features above, `ctx.portfolio`,
`ctx.isMonthEnd`, …) and returns orders for the next open. It never sees future rows. A sell with
`stop` / `target` is worked through the next session (gaps fill at the open, stop first when both
trade); a buy's `exits` puts a stop and target on the new shares the same day.

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
