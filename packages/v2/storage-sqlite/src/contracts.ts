import type { Operation } from "@standard-durability/core";
import type {
  Accepted,
  JournalBindingOptions,
  OwnedJournal,
  ActivationIntents,
} from "@sweatpan.ts/durable";
import type { Serializer } from "@sweatpan.ts/storage";

/** One stored row keyed by column name. Blob columns may surface as ArrayBuffer. */
export type SqliteRow = Record<string, unknown>;

/**
 * Minimal synchronous SQLite surface the journal needs. Node `DatabaseSync` and the
 * Durable Object `ctx.storage.sql` both fit; asynchronous drivers (D1, libSQL) do not.
 */
export interface SqliteConnection {
  /** Run DDL or other statements without results. */
  exec(sql: string): void;
  get(sql: string, ...params: unknown[]): SqliteRow | undefined;
  all(sql: string, ...params: unknown[]): readonly SqliteRow[];
  run(sql: string, ...params: unknown[]): { readonly changes: number };
  /** Run work atomically; commit when it returns and roll back when it throws. */
  transaction<T>(work: () => T): T;
}

/** Connection is caller-owned; one tree's records must share this database. */
export interface SqliteJournalOptions<Y> extends JournalBindingOptions {
  readonly connection: SqliteConnection;
  /** Stable root identity. Supply the same identity and pinned program on reopening. */
  readonly id?: string;
  /** Scoped API facade; resolve may suspend but always runs before BEGIN IMMEDIATE. */
  readonly serialization: { resolve(): Operation<Serializer, Y> };
}

/** SQLite-backed owned tree. Opening creates fresh bindings, not an evaluator. */
export interface SqliteJournalStore<R, Q, V, E, S, Y> {
  readonly id: string;
  /** Root-tree intent committed atomically with journal writes. */
  readonly activations: ActivationIntents<Y>;
  /** Root-only access; rebind child projections through ensureChild. Does not own the connection. */
  open(): OwnedJournal<R, Q, V, E, S, Y>;
}

/** Structural subset of Cloudflare `DurableObjectStorage` used by the journal. */
export interface DurableObjectSqlStorage {
  readonly sql: {
    exec(
      sql: string,
      ...params: unknown[]
    ): { toArray(): SqliteRow[]; readonly rowsWritten: number };
  };
  transactionSync<T>(work: () => T): T;
}

/** A storage-local position is not an execution sequence or a portable resume token. */
export interface SqliteHistoryEntry {
  readonly position: number;
  readonly tree: string;
  readonly execution: string;
  readonly accepted: Accepted<unknown, unknown, unknown>;
}

/** Bind observation to an already acquired connection and serializer. No IO on construction. */
export interface SqliteHistoryReaderOptions {
  readonly connection: Pick<SqliteConnection, "all">;
  readonly serializer: Serializer;
}

/** Database-wide accepted records; does not expose pending work or execution authority. */
export interface SqliteHistoryReader {
  /**
   * One bounded page in SQLite insertion order. `after` defaults to zero; use the
   * last returned position for the next page on this same database/snapshot.
   * Empty means exhausted at this read. Limit bounds count, not bytes. Caller owns
   * transaction isolation and connection lifetime. No schema setup or writes occur.
   */
  read(options: { readonly after?: number; readonly limit: number }): readonly SqliteHistoryEntry[];
}
