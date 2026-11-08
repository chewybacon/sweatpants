import {
  decorateFunction,
  type Composition,
  type Decorator,
  type Operation,
} from "@standard-durability/core";
import type { SqliteConnection } from "@sweatpan.ts/storage-sqlite";

/** Application-local policy. Generic transaction signatures remain intact. */
export type SqliteDecorators = {
  readonly [K in keyof SqliteConnection]?: Decorator<SqliteConnection[K]>;
};

/** Build a snapshot of SQL policy. The caller still owns the underlying connection. */
export function decorateSqlite(
  connection: SqliteConnection,
  layers: SqliteDecorators,
): SqliteConnection {
  return {
    exec: decorateFunction(connection.exec.bind(connection), [layers.exec]),
    get: decorateFunction(connection.get.bind(connection), [layers.get]),
    all: decorateFunction(connection.all.bind(connection), [layers.all]),
    run: decorateFunction(connection.run.bind(connection), [layers.run]),
    transaction: decorateFunction(connection.transaction.bind(connection), [layers.transaction]),
  };
}

/** Scope selects acquisition; ordinary SQL calls never yield inside a transaction. */
export function createScopedSqlite<Y>(composition: Composition<Y>, driver: SqliteConnection) {
  return composition.createApi("sqlite-connection", {
    *acquire(): Operation<SqliteConnection, Y> {
      return driver;
    },
  });
}
