import type { DatabaseSync } from "node:sqlite";
import type { Operation } from "@standard-durability/core";
import type { JournalBindingOptions, OwnedJournal } from "@sweatpan.ts/durable";
import type { Serializer } from "@sweatpan.ts/storage";

/** Node connection is caller-owned; one tree's records must share this database. */
export interface SqliteJournalOptions<Y> extends JournalBindingOptions {
  readonly database: DatabaseSync;
  /** Stable root identity. Supply the same identity and pinned program on reopening. */
  readonly id?: string;
  /** Scoped API facade; resolve may suspend but always runs before BEGIN IMMEDIATE. */
  readonly serialization: { resolve(): Operation<Serializer, Y> };
}

/** SQLite-backed owned tree. Opening creates fresh bindings, not an evaluator. */
export interface SqliteJournalStore<R, Q, V, E, S, Y> {
  readonly id: string;
  /** Root-only access; rebind child projections through ensureChild. Does not own the connection. */
  open(): OwnedJournal<R, Q, V, E, S, Y>;
}
