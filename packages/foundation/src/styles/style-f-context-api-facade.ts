/**
 * Style F — Context stores the API facade, not the raw driver.
 *
 * The raw implementation remains private to the API's terminal handler. Trusted
 * consumers use the Context-injected facade, so their calls re-enter the
 * module-level API middleware chain without capturing a Scope.
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

export interface ExecutionStoreF {
  load(executionId: string): Operation<ExecutionRecord | null>;
  commit(record: ExecutionRecord, expectedRevision: number | null): Operation<CommitResult>;
}

const unavailableDriverF: ExecutionStoreF = {
  *load() {
    throw new Error("No execution store driver is installed");
  },
  *commit() {
    throw new Error("No execution store driver is installed");
  },
};

const RawDriverContextF = createContext<ExecutionStoreF>("style-f-raw-driver", unavailableDriverF);

export const StoreApiF = createApi("style-f-context-api-facade", {
  *load(executionId: string): Operation<ExecutionRecord | null> {
    const driver = yield* RawDriverContextF.expect();
    return yield* driver.load(executionId);
  },

  *commit(record: ExecutionRecord, expectedRevision: number | null): Operation<CommitResult> {
    const driver = yield* RawDriverContextF.expect();
    return yield* driver.commit(record, expectedRevision);
  },
});

const facade = StoreApiF.operations as unknown as ExecutionStoreF;

export const StoreContextF = createContext<ExecutionStoreF>("style-f-api-facade", facade);

export function* useStoreF(): Operation<ExecutionStoreF> {
  return yield* StoreContextF.expect();
}

export function createMemoryDriverF(): ExecutionStoreF {
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

export function* installDriverF(driver: ExecutionStoreF): Operation<void> {
  yield* RawDriverContextF.set(driver);
  yield* StoreContextF.set(facade);
}

export function* installMemoryDriverF(): Operation<void> {
  yield* installDriverF(createMemoryDriverF());
}
