import type { SyncMiddleware, Composition } from "@standard-durability/core";
import type { SqliteConnection } from "@sweatpan.ts/storage-sqlite";

export type SqliteStatementMiddleware = Pick<
  SyncMiddleware<SqliteConnection>,
  "exec" | "get" | "all" | "run"
>;

/** Bind the existing synchronous driver through core scoped middleware. */
export function createScopedSqlite<Y>(composition: Composition<Y>, driver: SqliteConnection) {
  return composition.createApi("sqlite-connection", { sync: driver });
}
