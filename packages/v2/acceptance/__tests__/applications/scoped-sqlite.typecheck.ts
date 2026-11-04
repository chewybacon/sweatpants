import type { SqliteConnection } from "@sweatpan.ts/storage-sqlite";
import type { SqliteStatementMiddleware } from "../../examples/scoped-sqlite.ts";
// Compile-only evidence: synchronous statement middleware keeps driver result types.
export const invalidAsyncLayer: SqliteStatementMiddleware = {
  // @ts-expect-error A SQL run must return its changes synchronously.
  run: (next) =>
    async function (...args) {
      return next(...args);
    },
};
export function preservesTransactionResult(connection: SqliteConnection) {
  const result: {
    readonly accepted: true;
  } = connection.transaction(() => ({ accepted: true }) as const);
  return result;
}
// TypeScript allows values (including Promises) from a void-returning function.
// The bound connection's runtime guard is still needed for untyped/void methods.
export const asyncVoidLayer: SqliteStatementMiddleware = {
  exec: (next) =>
    async function (...args) {
      next(...args);
    },
};
