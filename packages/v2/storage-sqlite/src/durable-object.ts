import type { DurableObjectSqlStorage, SqliteConnection } from "./contracts.ts";

/**
 * Adapt Durable Object SQLite storage (`ctx.storage`). Transactions use
 * `transactionSync`, because Durable Objects reject SQL BEGIN/SAVEPOINT. Blob columns
 * read back as ArrayBuffer; the journal normalizes them before decoding.
 */
export function createDurableObjectSqliteConnection(
  storage: DurableObjectSqlStorage,
): SqliteConnection {
  const { sql } = storage;
  return {
    exec(statement) {
      sql.exec(statement);
    },
    get(statement, ...params) {
      return sql.exec(statement, ...params).toArray()[0];
    },
    all(statement, ...params) {
      return sql.exec(statement, ...params).toArray();
    },
    run(statement, ...params) {
      return { changes: sql.exec(statement, ...params).rowsWritten };
    },
    transaction(work) {
      return storage.transactionSync(work);
    },
  };
}
