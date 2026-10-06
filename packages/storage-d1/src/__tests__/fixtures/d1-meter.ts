import type {
  D1Database,
  D1DatabaseSession,
  D1PreparedStatement,
  D1Result,
} from "@cloudflare/workers-types";

export interface QueryCost {
  sql: string;
  bindings: unknown[];
  rowsRead: number;
  rowsWritten: number;
}
/** Records real workerd billing metadata without replacing SQL execution. */
export function meterD1(database: D1Database) {
  const queries: QueryCost[] = [];
  const originals = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; sql: string; bindings: unknown[] }
  >();
  const record = (sql: string, bindings: unknown[], result: D1Result) => {
    queries.push({
      sql,
      bindings,
      rowsRead: result.meta.rows_read,
      rowsWritten: result.meta.rows_written,
    });
  };
  function statement(
    inner: D1PreparedStatement,
    sql: string,
    bindings: unknown[] = [],
  ): D1PreparedStatement {
    const wrapped = new Proxy(inner, {
      get(target, property) {
        if (property === "bind")
          return (...args: unknown[]) => statement(target.bind(...args), sql, args);
        if (property === "all" || property === "run")
          return async () => {
            const result = await target.all();
            record(sql, bindings, result);
            return result;
          };
        if (property === "first")
          return async (column?: string) => {
            const result = await target.all<Record<string, unknown>>();
            record(sql, bindings, result);
            return column === undefined
              ? (result.results[0] ?? null)
              : (result.results[0]?.[column] ?? null);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, { statement: inner, sql, bindings });
    return wrapped;
  }
  function session(inner: D1DatabaseSession): D1DatabaseSession {
    return new Proxy(inner, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const entries = statements.map((item) => originals.get(item)!);
            const results = await target.batch(entries.map((item) => item.statement));
            results.forEach((result, index) =>
              record(entries[index]!.sql, entries[index]!.bindings, result),
            );
            return results;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return {
    queries,
    database: new Proxy(database, {
      get(target, property) {
        if (property === "withSession")
          return (...args: Parameters<D1Database["withSession"]>) =>
            session(target.withSession(...args));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
