import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/** Small synchronous storage boundary shared by the HTTP service and future desktop host. */
export class SqliteDatabase {
  private readonly native: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    this.native = new DatabaseSync(path, { readOnly: options.readonly ?? false });
  }

  prepare(sql: string): SqliteStatement { return new SqliteStatement(this.native.prepare(sql)); }
  exec(sql: string): void { this.native.exec(sql); }
  pragma(sql: string): Record<string, unknown>[] { return this.prepare(`PRAGMA ${sql}`).all(); }

  transaction<Args extends unknown[], Result>(action: (...args: Args) => Result): (...args: Args) => Result {
    return (...args: Args): Result => {
      const nested = this.transactionDepth > 0;
      const savepoint = `decklens_${++this.savepointSequence}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      this.transactionDepth++;
      try {
        const result = action(...args);
        if (result && typeof (result as { then?: unknown }).then === "function") throw new TypeError("SQLite transactions must complete synchronously.");
        this.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        try {
          if (nested) {
            this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } else this.exec("ROLLBACK");
        } catch { /* Keep the original failure if SQLite already rolled the transaction back. */ }
        throw error;
      } finally { this.transactionDepth--; }
    };
  }

  close(): void { this.native.close(); }
}

export class SqliteStatement {
  constructor(private readonly native: StatementSync) {}
  run(...values: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.native.run(...values.map(binding));
  }
  get(...values: unknown[]): Record<string, unknown> | undefined {
    const row = this.native.get(...values.map(binding));
    return row ? { ...row } : undefined;
  }
  all(...values: unknown[]): Record<string, unknown>[] {
    return this.native.all(...values.map(binding)).map(row => ({ ...row }));
  }
}

function binding(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  throw new TypeError("SQLite bindings must be strings, numbers, bigints, byte arrays, or null.");
}
