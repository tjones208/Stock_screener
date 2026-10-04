// Thin DuckDB wrapper.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export class Duck {
  private conn: DuckDBConnection;
  private constructor(conn: DuckDBConnection) {
    this.conn = conn;
  }

  static async open(path = ":memory:", settings: Record<string, string> = {}) {
    const db = await DuckDBInstance.create(path, settings);
    return new Duck(await db.connect());
  }

  async run(sql: string) {
    await this.conn.run(sql);
  }

  /** Rows as plain JSON-friendly objects (cast numerics to DOUBLE / INTEGER and dates to VARCHAR in SQL). */
  async all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const r = await this.conn.runAndReadAll(sql);
    return r.getRowObjectsJson() as T[];
  }

  close() {
    this.conn.closeSync();
  }
}

/** Quote a path or string as a SQL literal. */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
