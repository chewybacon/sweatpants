import type { SqliteHistoryReader, SqliteHistoryReaderOptions } from "./contracts.ts";
import type { Accepted } from "@sweatpan.ts/durable";

/**
 * Read accepted history across a SQLite database without opening writer authority.
 * Construction performs no IO. Caller owns connection, serializer and read transaction.
 */
export function createSqliteHistoryReader({
  connection,
  serializer,
}: SqliteHistoryReaderOptions): SqliteHistoryReader {
  return {
    read({ after = 0, limit }) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Invalid SQLite history range");
      }
      return connection
        .all(
          "SELECT rowid AS position, tree, execution, format, payload FROM sweatpants_history WHERE rowid > ? ORDER BY rowid LIMIT ?",
          after,
          limit,
        )
        .map((row) => {
          if (row.format !== serializer.format) {
            throw new Error("Unsupported stored serialization format");
          }
          const payload = row.payload;
          // Trusted storage decoding, not validation of application payloads.
          const accepted = serializer.decode(
            payload instanceof ArrayBuffer ? new Uint8Array(payload) : (payload as Uint8Array),
          ) as Accepted<unknown, unknown, unknown>;
          return {
            position: row.position as number,
            tree: row.tree as string,
            execution: row.execution as string,
            accepted,
          };
        });
    },
  };
}
