import type { DatabaseSync } from "node:sqlite";
import type { SqliteConnection, SqliteRow } from "./contracts.ts";

/**
 * Adapt a caller-owned Node `DatabaseSync`. Transactions use BEGIN IMMEDIATE and roll
 * back when work throws. Do not wrap journal calls in another transaction on it.
 */
export function createNodeSqliteConnection(database: DatabaseSync): SqliteConnection {
  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  function prepare(sql: string) {
    let statement = statements.get(sql);
    if (!statement) {
      statement = database.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }
  return {
    exec(sql) {
      database.exec(sql);
    },
    get(sql, ...params) {
      return prepare(sql).get(...(params as never[])) as SqliteRow | undefined;
    },
    all(sql, ...params) {
      return prepare(sql).all(...(params as never[])) as SqliteRow[];
    },
    run(sql, ...params) {
      const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
      function prepare(sql: string) {
        let statement = statements.get(sql);
        if (!statement) {
          statement = database.prepare(sql);
          statements.set(sql, statement);
        }
        return statement;
      }
      return { changes: Number(prepare(sql).run(...(params as never[])).changes) };
    },
    transaction(work) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
