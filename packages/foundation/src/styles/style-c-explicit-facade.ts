/**
 * Style C — plain driver interface plus a hand-written facade.
 *
 * This is the shape currently shipped in `api.ts`: every operation is declared
 * three times (interface, facade, adapter).
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

export interface ExecutionStoreC {
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

export const StoreContextC = createContext<ExecutionStoreC | undefined>(
  "style-c-execution-store",
  undefined,
);

function* driver(): Operation<ExecutionStoreC> {
  const installed = yield* StoreContextC.get();
  if (!installed) {
    throw new StoreUnavailable();
  }
  return installed;
}

export const StoreApiC = createApi("style-c-execution-store", {
  *load(executionId: string): Operation<ExecutionRecord | null> {
    const selected = yield* driver();
    return yield* selected.load(executionId);
  },
  *commit(record: ExecutionRecord, expectedRevision: number | null): Operation<CommitResult> {
    const selected = yield* driver();
    return yield* selected.commit(record, expectedRevision);
  },
});

/** Writing a driver in Style C: identical to Style B. */
export function createMemoryDriverC(): ExecutionStoreC {
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

export function* installMemoryDriverC(): Operation<void> {
  yield* StoreContextC.set(createMemoryDriverC());
}
