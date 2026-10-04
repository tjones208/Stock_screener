// The app's monthly momentum strategy, driven by the same rule functions the live app uses
// (lib/momentum: ranking, sizing, sector caps, stops, exits, regime band, volatility brake, wash
// sales, long-term deferral, ticket retries). Parameters are the app's settings keys.
//
// Differences from live, because the history doesn't exist: no market-cap filter (price and
// dollar-volume only), no earnings blackout, no buyout / pending-deal filters, no data flags.
// B and E follow the account's equity each day unless `compound` is false.
import type { Ctx, StrategyDef } from "../engine/engine.ts";
import type { Order, Row } from "../engine/types.ts";
import { capitalAndSlots, MOM_CHOICES, MOM_DEFAULTS, MOM_FIELDS, normalizeMomConfig, type MomConfig } from "../../../lib/momentum/config.ts";
import { entryCap, planPortfolio, type Candidate, type Held } from "../../../lib/momentum/sizing.ts";
import { holdCutoff, holdVerdict, entryOk, rankUniverse, type RuleRow } from "../../../lib/momentum/ranking.ts";
import { regimeAt } from "../../../lib/momentum/regime.ts";
import { volScale, washBlocked } from "../../../lib/momentum/risk.ts";
import { advanceTicket, fillLevels, sharesAt, type TicketState } from "../../../lib/momentum/orders.ts";
import { applyLtDeferral, dueDeferrals, nightlyStop, reviewPosition, topUpShares, type ExitOrder, type Lot as RuleLot, type Position } from "../../../lib/momentum/stops.ts";
import { momSector } from "../../../lib/momentum/sector-key.ts";

const EXCHANGES = new Set(["XNYS", "XNAS", "XASE"]);
// Settings with no effect in a backtest: no point-in-time market caps, earnings dates or idle-cash ETF.
const UNUSED = new Set(["min_market_cap", "earnings_blackout_days", "cash_etf", "tax_rate_st", "tax_rate_lt"]);

type Ticket = TicketState & { ticker: string; T: number; atr: number; sector: string; sigma: number; kind: "buy" | "topup"; plan: string };
type Ranked = { row: Row; comp_rank: number; mom_pct: number; h52: number; entry: boolean; inUniverse: boolean };

export const momentum: StrategyDef = {
  name: "momentum",
  description: "The app's monthly momentum rotation (lib/momentum rules). Params = the app's settings keys, plus compound / regime_ticker.",
  defaults: { ...MOM_DEFAULTS, compound: true, regime_ticker: "SPY" },
  fields: [
    { key: "compound", label: "B and E follow account equity (compounding)", group: "Backtest" },
    { key: "regime_ticker", label: "Regime ticker", group: "Backtest" },
    // The app's settings, minus the ones a backtest can't use (no market caps, earnings, news, calls).
    ...MOM_FIELDS.filter((f) => !UNUSED.has(f.key) && !["Covered calls", "Data-quality gate"].includes(f.group))
      .map((f) => ({ key: f.key, label: f.label, group: f.group, ...(Array.isArray(MOM_CHOICES[f.key]) ? { choices: MOM_CHOICES[f.key] as readonly string[] } : {}) })),
  ],
  warmupDays: 260,
  create(params, env) {
    const base = normalizeMomConfig(params);
    const compound = params.compound !== false;
    const regimeTicker = String(params.regime_ticker ?? "SPY");
    const spy: { d: string; c: number }[] = [];
    let regime: boolean | null = null;          // state at the last month-end
    const stops = new Map<number, { stop: number; hc: number; D: number }>();
    const deferred = new Map<number, { trigger: number; shares: number }>();
    let tickets: Ticket[] = [];
    const dropped = new Map<string, Set<string>>(); // plan → tickers dropped from it
    let alternates = new Map<string, string[]>();   // plan → alternates in order

    const cfgFor = (ctx: Ctx): MomConfig => (compound ? { ...base, B: ctx.equity, E: ctx.equity } : base);
    const sectorOf = (ctx: Ctx, t: string) => momSector({ ticker: t, sic_code: ctx.tickers.get(t)?.sic_code ?? null });
    let dayIdx: Map<string, number> | null = null;
    const ageOk = (ctx: Ctx, r: Row, cfg: MomConfig) => {
      dayIdx ??= new Map(ctx.days.map((d, k) => [d, k]));
      const first = dayIdx.get(r.first_d) ?? -1;
      return first >= 0 && ctx.i - first + 1 >= cfg.min_history_days;
    };
    const inUniverse = (ctx: Ctx, r: Row, cfg: MomConfig) => {
      const info = ctx.tickers.get(r.ticker);
      const typeOk = !info?.type || (info.type === "CS" && (!info.exchange || EXCHANGES.has(info.exchange)));
      return typeOk && r.c >= cfg.min_price && (r.median_dv60 ?? 0) >= cfg.min_median_dollar_vol_60d && r.mom_12_1 != null && r.hi252 != null && ageOk(ctx, r, cfg);
    };

    /** Today's ranking: universe names ranked; held names outside it placed within that distribution. */
    let rankCache: { d: string; map: Map<string, Ranked>; universe: number } | null = null;
    const rank = (ctx: Ctx, cfg: MomConfig) => {
      if (rankCache?.d === ctx.d) return rankCache;
      const uni = [...ctx.today.values()].filter((r) => inUniverse(ctx, r, cfg));
      const input = (rows: Row[]) => rows.map((r) => ({ ticker: r.ticker, mom: r.mom_12_1!, h52: r.c / r.hi252!, sigma252: r.vol252 }));
      const ranked = rankUniverse(input(uni), cfg.rank_method);
      const byT = new Map(uni.map((r) => [r.ticker, r]));
      const map = new Map<string, Ranked>();
      for (const x of ranked) {
        const row = byT.get(x.ticker)!;
        const rr: RuleRow = { mom: x.mom, mom_pct: x.mom_pct, h52: x.h52, days_since_high: row.days_since_high ?? 999, comp_rank: x.comp_rank, close: row.c, median_dv60: row.median_dv60, buyoutReview: false, inUniverse: true };
        map.set(x.ticker, { row, comp_rank: x.comp_rank, mom_pct: x.mom_pct, h52: x.h52, entry: entryOk(rr, cfg), inUniverse: true });
      }
      for (const t of ctx.portfolio.tickers()) {
        const row = ctx.row(t);
        if (map.has(t) || !row || row.mom_12_1 == null || row.hi252 == null) continue;
        const r = rankUniverse(input([...uni, row]), cfg.rank_method).find((x) => x.ticker === t)!;
        map.set(t, { row, comp_rank: r.comp_rank, mom_pct: r.mom_pct, h52: r.h52, entry: false, inUniverse: false });
      }
      rankCache = { d: ctx.d, map, universe: uni.length };
      return rankCache;
    };
    const ruleRow = (x: Ranked): RuleRow => ({
      mom: x.row.mom_12_1!, mom_pct: x.mom_pct, h52: x.h52, days_since_high: x.row.days_since_high ?? 999, comp_rank: x.comp_rank,
      close: x.row.c, median_dv60: x.row.median_dv60, buyoutReview: false, inUniverse: x.inUniverse,
    });

    const heldList = (ctx: Ctx, exclude: Set<string> = new Set()): Held[] => {
      const out: Held[] = ctx.portfolio.tickers().filter((t) => !exclude.has(t)).map((t) => ({
        ticker: t, sigma63: ctx.row(t)?.vol63 ?? null, sector: sectorOf(ctx, t), value: ctx.portfolio.sharesOf(t) * (ctx.lastClose(t) ?? 0),
      }));
      for (const k of tickets) if (k.kind === "buy" && !exclude.has(k.ticker)) out.push({ ticker: k.ticker, sigma63: k.sigma, sector: k.sector, value: k.T });
      return out;
    };
    const candidates = (ctx: Ctx, cfg: MomConfig, skip: Set<string>): Candidate[] => {
      const r = rank(ctx, cfg);
      return [...r.map.values()].filter((x) => x.inUniverse && !skip.has(x.row.ticker)).sort((a, b) => a.comp_rank - b.comp_rank).map((x) => ({
        ticker: x.row.ticker, comp_rank: x.comp_rank, close: x.row.c, sigma63: x.row.vol63, atr20: x.row.atr20, sector: sectorOf(ctx, x.row.ticker), entry_ok: x.entry,
      }));
    };
    const wash = (ctx: Ctx, cfg: MomConfig) =>
      new Set(washBlocked(ctx.portfolio.closed.map((c) => ({ ticker: c.ticker, exit_date: c.exitD, pnl: c.pnl })), ctx.d, cfg.wash_sale_block_days).keys());

    const buyOrder = (k: Ticket, cfg: MomConfig): Order => ({
      side: "buy", ticker: k.ticker, limit: k.cap, tag: k.kind,
      // Re-size at the real fill price (spec 6.6): min(target ÷ price, risk budget ÷ D at that price).
      shares: (price) => (k.kind === "topup" ? Math.floor(k.T / price) : sharesAt(k.T, price, k.atr, cfg).shares),
    });

    /** Give a dropped ticket's slot to the next name from today's ranking (normally the next alternate). */
    const promote = (ctx: Ctx, cfg: MomConfig, plan: string, m: number, riskOn: boolean | null) => {
      const skip = new Set([...(dropped.get(plan) ?? []), ...ctx.portfolio.tickers(), ...tickets.map((k) => k.ticker)]);
      const p = planPortfolio({ cfg, candidates: candidates(ctx, cfg, skip), held: heldList(ctx), riskOn, washBlocked: wash(ctx, cfg), scale: m });
      const b = p.buys[0];
      if (!b) return;
      const row = ctx.row(b.ticker)!;
      tickets.push({ ticker: b.ticker, T: b.T, atr: row.atr20!, sector: b.sector, sigma: b.sigma63, kind: "buy", plan,
        status: "open", retry_day: 1, trade_date: ctx.days[ctx.i + 1] ?? ctx.d, s_close: b.S, cap: b.cap });
    };

    return {
      onFill(f, ctx, lot, closed) {
        if (f.side === "buy" && lot) {
          const k = tickets.find((x) => x.ticker === f.ticker);
          const cfg = cfgFor(ctx);
          const lv = fillLevels(f.price, k?.atr ?? ctx.row(f.ticker)?.atr20 ?? f.price * 0.03, f.d, cfg);
          stops.set(lot.id, { stop: lv.stop0, hc: f.price, D: lv.D });
          tickets = tickets.filter((x) => x !== k);
        }
        for (const c of closed ?? []) if (!ctx.portfolio.lots.some((l) => l.id === c.id)) { stops.delete(c.id); deferred.delete(c.id); }
      },
      // Unfilled tickets stay open and roll with the retry rules in onClose.
      onUnfilled() {},

      onClose(ctx) {
        const spyRow = ctx.row(regimeTicker);
        if (spyRow) spy.push({ d: ctx.d, c: spyRow.c });
        if (ctx.isMonthEnd && spyRow) {
          const r = regimeAt(spy, ctx.d, ctx.cal, base.regime_sma_months, base.regime_band_pct, regime);
          if (r.riskOn != null) regime = r.riskOn;
        }
        if (!ctx.trading) return [];
        const cfg = cfgFor(ctx);
        const { N } = capitalAndSlots(cfg);
        const kind = ctx.isMonthEnd ? "monthly" : ctx.isWeekEnd ? "weekly" : "daily";
        const m = volScale(spy.map((x) => x.c), cfg).m;
        const brake = kind !== "daily" && m < cfg.vol_trim_trigger;
        const orders: Order[] = [];

        // Nightly trailing stops.
        for (const l of ctx.portfolio.lots) {
          const st = stops.get(l.id), r = ctx.row(l.ticker);
          if (!st || !r) continue;
          st.hc = Math.max(st.hc, r.c);
          st.stop = nightlyStop(st.stop, st.hc, r.c, r.atr20, st.D, cfg).stop;
        }

        // Exit review (sells first), month-end top-ups.
        const targets = new Map<string, number>();
        if (kind === "monthly" || brake) {
          const p = planPortfolio({ cfg, candidates: [], held: heldList(ctx, new Set(tickets.map((k) => k.ticker))), riskOn: true, scale: m });
          for (const h of p.heldWeights) targets.set(h.ticker, h.T);
        }
        const r = kind === "monthly" ? rank(ctx, cfg) : null;
        const cutoff = r ? holdCutoff(cfg, N, r.universe) : 0;
        const leaving = new Set<string>();
        const blocked = wash(ctx, cfg);
        for (const t of ctx.portfolio.tickers()) {
          const row = ctx.row(t);
          if (!row) continue; // no bar: the engine closes it if it doesn't trade again
          const lots: RuleLot[] = ctx.portfolio.lotsOf(t).map((l) => ({
            id: l.id, ticker: t, shares: l.shares, fill_price: l.price, d: stops.get(l.id)?.D ?? row.c * 0.1, stop: stops.get(l.id)?.stop ?? 0,
            filled_at: l.d, lt_date: l.ltDate, lt_deferred_trigger: deferred.get(l.id)?.trigger ?? null, lt_deferred_shares: deferred.get(l.id)?.shares ?? null,
          }));
          const x = r?.map.get(t);
          const hv = x ? holdVerdict(ruleRow(x), cfg, cutoff) : { ok: false, reason: "No ranking row" };
          const p: Position = {
            ticker: t, lots, close: row.c, active: true, holdOk: kind === "monthly" ? hv.ok : true, holdReason: hv.reason, buyoutNews: null,
            target: kind === "monthly" ? targets.get(t) ?? null : null, entryOk: x?.entry ?? false, volTarget: brake ? targets.get(t) ?? null : null,
          };
          const reviewed = reviewPosition(p, { monthEnd: kind === "monthly", riskOn: regime, cfg });
          const { order: kept, deferred: waits } = applyLtDeferral(reviewed, lots, row.c, ctx.d, cfg);
          for (const w of waits) deferred.set(w.id, { trigger: reviewed!.trigger, shares: w.shares });
          let order: ExitOrder | null = kept;
          const due = dueDeferrals(lots, row.c, ctx.d).filter((l) => !kept?.lots.some((y) => y.id === l.id));
          if (due.length) {
            const extra = due.map((l) => ({ id: l.id, shares: Math.min(l.shares, l.lt_deferred_shares ?? l.shares) }));
            for (const l of due) deferred.delete(l.id);
            order = order ? { ...order, lots: [...order.lots, ...extra], shares: order.shares + extra.reduce((a, y) => a + y.shares, 0) }
              : { ticker: t, trigger: due[0].lt_deferred_trigger as ExitOrder["trigger"], lots: extra, shares: extra.reduce((a, y) => a + y.shares, 0), reason: "LT deferral ended", urgent: false, deadlineDays: 0 };
          }
          if (order) {
            orders.push({ side: "sell", ticker: t, shares: order.shares, lots: order.lots, tag: `T${order.trigger}` });
            if (order.shares >= ctx.portfolio.sharesOf(t) - 1e-9) leaving.add(t);
          } else if (kind === "monthly" && regime === true && !blocked.has(t)) {
            const add = topUpShares(p, cfg);
            if (add > 0 && !tickets.some((k) => k.ticker === t)) {
              tickets.push({ ticker: t, T: add * row.c, atr: row.atr20 ?? row.c * 0.03, sector: sectorOf(ctx, t), sigma: row.vol63 ?? 0.3, kind: "topup", plan: ctx.d,
                status: "open", retry_day: 1, trade_date: ctx.days[ctx.i + 1] ?? ctx.d, s_close: row.c, cap: entryCap(row.c, cfg) });
            }
          }
        }

        // Regime exit: no buys; open tickets are cancelled.
        if (kind === "monthly" && regime !== true) tickets = [];

        // Roll unfilled tickets (retry rules), promoting the next name into a dropped slot.
        const next = ctx.days[ctx.i + 1] ?? "9999-12-31";
        for (const k of [...tickets]) {
          if (!k.trade_date || k.trade_date > ctx.d) continue; // placed today: first attempt is tomorrow
          const x = k.retry_day + 1 === cfg.entry_retry_reset_day ? rank(ctx, cfg).map.get(k.ticker) : undefined;
          const row = ctx.row(k.ticker);
          const adv = advanceTicket(k, next, row ? { entry_ok: x?.entry ?? false, close: row.c } : null, cfg);
          if (adv.status === "dropped") {
            tickets = tickets.filter((y) => y !== k);
            if (!dropped.has(k.plan)) dropped.set(k.plan, new Set());
            dropped.get(k.plan)!.add(k.ticker);
            if (k.kind === "buy" && regime === true) promote(ctx, cfg, k.plan, m, regime);
          } else Object.assign(k, { retry_day: adv.retry_day, trade_date: adv.trade_date, s_close: adv.s_close, cap: adv.cap });
        }

        // New plan on weekly / monthly signals.
        if (kind !== "daily" && regime === true) {
          const skip = new Set([...ctx.portfolio.tickers().filter((t) => !leaving.has(t)), ...tickets.map((k) => k.ticker), ...leaving]);
          const held = heldList(ctx, leaving);
          const plan = planPortfolio({ cfg, candidates: candidates(ctx, cfg, skip), held, riskOn: regime, washBlocked: blocked, scale: m });
          for (const b of plan.buys) {
            const row = ctx.row(b.ticker)!;
            tickets.push({ ticker: b.ticker, T: b.T, atr: row.atr20!, sector: b.sector, sigma: b.sigma63, kind: "buy", plan: ctx.d,
              status: "open", retry_day: 1, trade_date: next, s_close: b.S, cap: b.cap });
          }
          alternates.set(ctx.d, plan.alternates.map((a) => a.ticker));
        }
        if (alternates.size > 24) alternates = new Map([...alternates].slice(-12));

        for (const k of tickets) orders.push(buyOrder(k, cfg));
        return orders;
      },
    };
  },
};
