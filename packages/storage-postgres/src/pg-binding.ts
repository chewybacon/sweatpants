import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { call, type Operation } from "effection";
import type { DurableKernel } from "@sweatpants/durable-storage-kernel";
import { DurableKernelError } from "@sweatpants/durable-storage-kernel";
import { createPostgresStorageComposition, type PostgresStorage } from "./repository.ts";
import { PostgresBindingError } from "./contract.ts";
import { initializePostgresStorage } from "./initialize.ts";
import { postgresSchema, type PostgresSchema } from "./schema.ts";

export const DEFAULT_POSTGRES_URL = "postgres://postgres:postgres@localhost:55432/sweatpants";

export interface PostgresStorageHandle {
  readonly storage: PostgresStorage;
  readonly database: NodePgDatabase<PostgresSchema>;
  readonly pool: Pool;
  /** Closes only kernel-created pools; caller-owned pools stay open. */
  close(): Operation<void>;
}

export interface PostgresStorageTestHandle extends PostgresStorageHandle {
  /** Test-only access for backend kernel conformance and benchmarking. */
  readonly kernel: DurableKernel;
}

export interface PostgresStorageOptions {
  /** Caller-owned drizzle database; skips pool creation. */
  database?: NodePgDatabase<PostgresSchema>;
  /** Caller-owned pool; closed only when created here. */
  pool?: Pool;
  connectionString?: string;
  initialize?: boolean;
  maxPoolSize?: number;
  /**
   * Postgres commit-wait policy. `off` keeps atomicity and CAS guarantees;
   * only the per-commit fsync wait is relaxed (a crash may lose the last
   * few milliseconds of commits). Deployment choice, not a semantic one.
   */
  synchronousCommit?: "on" | "off";
  /** Test-only fault injection at the kernel seam. */
  faultInjection?: (point: string) => void;
}

function unavailable(message: string, cause?: unknown): DurableKernelError {
  return new DurableKernelError("durable_kernel_unavailable", message, { cause });
}

export async function openPostgresStorage(
  options: PostgresStorageOptions = {},
): Promise<PostgresStorageHandle> {
  if (options.database && (options.connectionString || options.pool)) {
    throw new PostgresBindingError(
      "binding_conflict",
      "Postgres storage accepts either a caller-owned database or connection settings, not both",
    );
  }

  const ownedPool =
    options.database || options.pool
      ? null
      : new Pool({
          connectionString: options.connectionString ?? DEFAULT_POSTGRES_URL,
          max: options.maxPoolSize ?? 10,
          ...(options.synchronousCommit === "off" ? { options: "-c synchronous_commit=off" } : {}),
        });
  const pool = options.pool ?? ownedPool!;
  const owned = ownedPool !== null;

  let database: NodePgDatabase<PostgresSchema>;
  try {
    database = options.database ?? drizzle(pool, { schema: postgresSchema });
    // Fail fast on an unreachable backend instead of on the first mutation.
    await database.execute(sql`select 1`);
    if (options.initialize !== false) {
      await initializePostgresStorage(database);
    }
  } catch (error) {
    if (owned) {
      try {
        await pool.end();
      } catch {
        // Opening already failed; preserve the original cause.
      }
    }
    if (error instanceof PostgresBindingError || error instanceof DurableKernelError) {
      throw error;
    }
    throw unavailable("Postgres storage open failed", error);
  }

  const composition = createPostgresStorageComposition({
    database,
    faultInjection: options.faultInjection,
  });

  return {
    storage: composition.storage,
    database,
    pool,
    *close(): Operation<void> {
      if (owned) {
        yield* call(() => pool.end());
      }
    },
  };
}

export type { PoolClient };

/** Test/bench-only handle exposing the raw kernel. Not exported at package root. */
export async function openPostgresStorageForTest(
  options: PostgresStorageOptions = {},
): Promise<PostgresStorageTestHandle> {
  const storage = await openPostgresStorage(options);
  const composition = createPostgresStorageComposition({
    database: storage.database,
    faultInjection: options.faultInjection,
  });
  return {
    storage: storage.storage,
    database: storage.database,
    pool: storage.pool,
    kernel: composition.kernel,
    *close(): Operation<void> {
      yield* storage.close();
    },
  };
}
