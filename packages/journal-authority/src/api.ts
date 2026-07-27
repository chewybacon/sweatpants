import { definePort } from "@sweatpants/foundation/port";
import type { Json } from "@sweatpants/foundation";
import type { DurableReference, ExecutionId } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import type {
  AppendReplayRequest,
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionStore,
  VersionedExecution,
} from "./store.ts";

export class ExecutionStoreUnavailable extends Error {
  readonly code = "store_unavailable";
  constructor() {
    super("No execution store driver is installed");
    this.name = "ExecutionStoreUnavailable";
  }
}

function unavailable(): never {
  throw new ExecutionStoreUnavailable();
}

/**
 * Execution storage as a port.
 *
 * Callers never thread a store instance and cannot reach an installed driver
 * directly. Optional middleware may observe, inject faults, or proxy these
 * operations, while the adapter keeps owning persistence mechanics and no
 * domain transition policy.
 */
export const ExecutionStorePort = definePort<ExecutionStore>("journal-authority-execution-store", {
  *loadExecution(_executionId: ExecutionId): Operation<VersionedExecution | null> {
    return unavailable();
  },
  *commitExecution(_request: CommitExecutionRequest): Operation<CommitExecutionResult> {
    return unavailable();
  },
  *putPayload(_value: Json | Uint8Array): Operation<DurableReference> {
    return unavailable();
  },
  *getPayload(_reference: DurableReference): Operation<Json | Uint8Array | null> {
    return unavailable();
  },
  *appendReplay(_request: AppendReplayRequest): Operation<DurableReference> {
    return unavailable();
  },
  *readReplay(_head: DurableReference | null): Operation<readonly Json[]> {
    return unavailable();
  },
});

export const ExecutionStoreApi = ExecutionStorePort.api;

/** Installs one execution-store adapter for the calling scope. */
export function installExecutionStore(store: ExecutionStore): Operation<void> {
  return ExecutionStorePort.installDriver(store);
}
