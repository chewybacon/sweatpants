import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";
import type { Json } from "@sweatpants/foundation";
import type { DurableReference, ExecutionId } from "@sweatpants/durable-execution";
import type {
  AppendReplayRequest,
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionStore,
  VersionedExecution,
} from "./store.ts";

/** Scope-installed persistence driver; absent outside an installed runtime. */
export const ExecutionStoreContext = createContext<ExecutionStore | undefined>(
  "journal-authority:execution-store",
  undefined,
);

export class ExecutionStoreUnavailable extends Error {
  readonly code = "store_unavailable";
  constructor() {
    super("No execution store driver is installed");
    this.name = "ExecutionStoreUnavailable";
  }
}

function* driver(): Operation<ExecutionStore> {
  const installed = yield* ExecutionStoreContext.get();
  if (!installed) {
    throw new ExecutionStoreUnavailable();
  }
  return installed;
}

/**
 * Execution storage as a dynamic API.
 *
 * Callers never thread a store instance. Optional middleware may observe,
 * inject faults, or proxy these operations, while the delegated driver keeps
 * owning persistence mechanics and no domain transition policy.
 */
export const ExecutionStoreApi = createApi("journal-authority-execution-store", {
  *loadExecution(executionId: ExecutionId): Operation<VersionedExecution | null> {
    return yield* (yield* driver()).loadExecution(executionId);
  },
  *commitExecution(request: CommitExecutionRequest): Operation<CommitExecutionResult> {
    return yield* (yield* driver()).commitExecution(request);
  },
  *putPayload(value: Json | Uint8Array): Operation<DurableReference> {
    return yield* (yield* driver()).putPayload(value);
  },
  *getPayload(reference: DurableReference): Operation<Json | Uint8Array | null> {
    return yield* (yield* driver()).getPayload(reference);
  },
  *appendReplay(request: AppendReplayRequest): Operation<DurableReference> {
    return yield* (yield* driver()).appendReplay(request);
  },
  *readReplay(head: DurableReference | null): Operation<readonly Json[]> {
    return yield* (yield* driver()).readReplay(head);
  },
});

/** Installs one execution-store driver for the calling scope. */
export function* installExecutionStore(store: ExecutionStore): Operation<void> {
  yield* ExecutionStoreContext.set(store);
}
