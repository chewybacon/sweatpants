import { describe, expect, it } from "vitest";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { SqliteSchema } from "../schema.ts";
import {
  createSqliteRepositories,
  type SqliteImmediateTransactions,
  type SweatpantsSqliteDatabase,
} from "../repository.ts";

type Expect<T extends true> = T;
type Extends<Left, Right> = Left extends Right ? true : false;

type D1DatabaseType = DrizzleD1Database<SqliteSchema>;
type DurableObjectDatabaseType = DrizzleSqliteDODatabase<SqliteSchema>;

type D1IsAsyncSqlite = Expect<
  Extends<D1DatabaseType, BaseSQLiteDatabase<"async", unknown, SqliteSchema>>
>;
type DurableObjectIsSyncSqlite = Expect<
  Extends<DurableObjectDatabaseType, BaseSQLiteDatabase<"sync", unknown, SqliteSchema>>
>;

function acceptFutureDriver<TResultKind extends "sync" | "async", TRunResult>(options: {
  database: SweatpantsSqliteDatabase<TResultKind, TRunResult>;
  transactions: SqliteImmediateTransactions<SweatpantsSqliteDatabase<TResultKind, TRunResult>>;
}) {
  return createSqliteRepositories(options);
}

function acceptD1(
  database: SweatpantsSqliteDatabase<"async", unknown>,
  transactions: SqliteImmediateTransactions<SweatpantsSqliteDatabase<"async", unknown>>,
) {
  return acceptFutureDriver({ database, transactions });
}

function acceptDurableObject(
  database: SweatpantsSqliteDatabase<"sync", unknown>,
  transactions: SqliteImmediateTransactions<SweatpantsSqliteDatabase<"sync", unknown>>,
) {
  return acceptFutureDriver({ database, transactions });
}

const typeProofs: [D1IsAsyncSqlite, DurableObjectIsSyncSqlite] = [true, true];

describe("SQLite driver boundary", () => {
  it("accepts Drizzle D1 and Durable Object database kinds at compile time", () => {
    expect(typeProofs).toEqual([true, true]);
    expect(typeof acceptD1).toBe("function");
    expect(typeof acceptDurableObject).toBe("function");
    expect(typeof createSqliteRepositories).toBe("function");
  });
});
