/**
 * Style E — context-backed implementation with a module-level API facade.
 *
 * The API remains the middleware seam used by ordinary callers. Its terminal
 * implementation resolves the currently inherited driver through Effection
 * Context.expect(), so trusted framework adapters can use useStoreE() without
 * capturing or rebinding a Scope.
 */
import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";

export interface ExecutionRecord {
  readonly executionId: string;
  readonly payload: string;
}

export type CommitResult =
  | { readonly status: "accepted"; readonly revision: number }
  | { readonly status: "conflict"; readonly actualRevision: number | null };

export interface ExecutionStoreE {
  load(executionId: string): Operation<ExecutionRecord | null>;
  commit(record: ExecutionRecord, expectedRevision: number | null): Operation<CommitResult>;
}

export class StoreUnavailable extends Error {
  readonly code = "store_unavailable";

  constructor() {
    super("No execution store driver is installed");
    this.name = "StoreUnavailable";
  }
}

const unavailableDriverE: ExecutionStoreE = {
  *load() {
    throw new StoreUnavailable();
  },
  *commit() {
    throw new StoreUnavailable();
  },
};

export const StoreContextE = createContext<ExecutionStoreE>(
  "style-e-execution-store",
  unavailableDriverE,
);

function* driver(): Operation<ExecutionStoreE> {
  return yield* StoreContextE.expect();
}

export const StoreApiE = createApi("style-e-execution-store", {
  *load(executionId: string): Operation<ExecutionRecord | null> {
    const store = yield* driver();
    return yield* store.load(executionId);
  },

  *commit(record: ExecutionRecord, expectedRevision: number | null): Operation<CommitResult> {
    const store = yield* driver();
    return yield* store.commit(record, expectedRevision);
  },
});

/** Trusted implementation-side access without capturing or binding a Scope. */
export function* useStoreE(): Operation<ExecutionStoreE> {
  return yield* StoreContextE.expect();
}

export function createMemoryDriverE(): ExecutionStoreE {
  const records = new Map<string, { revision: number; record: ExecutionRecord }>();
  return {
    *load(executionId) {
      return records.get(executionId)?.record ?? null;
    },
    *commit(record, expectedRevision) {
      const current = records.get(record.executionId) ?? null;
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== expectedRevision) {
        return { status: "conflict", actualRevision };
      }
      const revision = (actualRevision ?? -1) + 1;
      records.set(record.executionId, { revision, record });
      return { status: "accepted", revision };
    },
  };
}

export function* installDriverE(driver: ExecutionStoreE): Operation<void> {
  yield* StoreContextE.set(driver);
}

export function* installMemoryDriverE(): Operation<void> {
  yield* installDriverE(createMemoryDriverE());
}
