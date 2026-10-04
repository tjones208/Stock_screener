// DataSource over a prepared data set (see prepare.ts), read with DuckDB.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DataSource } from "../engine/engine.ts";
import type { Dividend, Row, TickerInfo } from "../engine/types.ts";
import { Duck, lit } from "./duck.ts";

const NUM = ["o", "h", "l", "c", "v", "dv", "ret1", "ret21", "ret63", "ret126", "ret252", "mom_12_1", "sma20", "sma50", "sma200",
  "hi252", "lo252", "vol20", "vol63", "vol252", "atr14", "atr20", "avg_dv20", "median_dv60"];

export class ParquetSource implements DataSource {
  private db: Duck;
  private dir: string;
  private cal: string[];
  private tk: Map<string, TickerInfo>;
  private dv: Map<string, Dividend[]>;
  private where: string;
  private constructor(db: Duck, dir: string, cal: string[], tk: Map<string, TickerInfo>, dv: Map<string, Dividend[]>, where: string) {
    this.db = db; this.dir = dir; this.cal = cal; this.tk = tk; this.dv = dv; this.where = where;
  }

  /**
   * `where` narrows the rows loaded per day (SQL on the daily columns), e.g. "c >= 1 and avg_dv20 >= 1e6"
   * to skip penny stocks and keep memory down. Held names should pass it, or they look delisted.
   */
  static async open(dir: string, opts: { where?: string; memoryLimit?: string } = {}) {
    const db = await Duck.open(":memory:", { memory_limit: opts.memoryLimit ?? "2GB" });
    const cal = (await db.all<{ d: string }>(`select d from read_parquet(${lit(join(dir, "calendar.parquet"))}) order by d`)).map((r) => r.d);
    const tk = new Map((await db.all<TickerInfo>(`select ticker, name, type, exchange, active, delisted, sic_code from read_parquet(${lit(join(dir, "tickers.parquet"))})`))
      .map((t) => [t.ticker, t]));
    const dv = new Map<string, Dividend[]>();
    for (const r of await db.all<Dividend>(`select ticker, ex_date, cash from read_parquet(${lit(join(dir, "dividends.parquet"))})`)) {
      const list = dv.get(r.ex_date) ?? [];
      list.push(r);
      dv.set(r.ex_date, list);
    }
    return new ParquetSource(db, dir, cal, tk, dv, opts.where ?? "true");
  }

  days() { return this.cal; }
  tickers() { return this.tk; }
  dividends() { return this.dv; }

  async rows(from: string, to: string) {
    const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
    const files = Array.from({ length: y1 - y0 + 1 }, (_, k) => join(this.dir, "daily", `year=${y0 + k}`, "data.parquet")).filter((f) => existsSync(f)).map(lit);
    if (!files.length) return new Map<string, Map<string, Row>>();
    const rows = await this.db.all<Row>(`
      select ticker, d, first_d, n::integer n, days_since_high::integer days_since_high, ${NUM.map((c) => `${c}::double ${c}`).join(", ")}
      from read_parquet([${files.join(", ")}])
      where d between ${lit(from)} and ${lit(to)} and (${this.where})`);
    const out = new Map<string, Map<string, Row>>();
    for (const r of rows) {
      let m = out.get(r.d);
      if (!m) out.set(r.d, (m = new Map()));
      m.set(r.ticker, r);
    }
    return out;
  }

  close() { this.db.close(); }
}
