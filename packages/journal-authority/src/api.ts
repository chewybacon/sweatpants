import { definePort, type PortFacade } from "@sweatpants/foundation/port";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import type {
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionControl,
  ExecutionObjectPointer,
  ExecutionStore,
  PrivateSegmentPointer,
  StoredExecutionObject,
  StoredPrivateSegment,
} from "./store.ts";

export class ExecutionStoreUnavailable extends Error {
  readonly code = "execution_store_unavailable";

  constructor() {
    super("No execution store driver is installed");
    this.name = "ExecutionStoreUnavailable";
  }
}

function unavailable(): never {
  throw new ExecutionStoreUnavailable();
}

export const ExecutionStorePort = definePort<ExecutionStore>("execution-store", {
  *loadControl(_executionId: string): Operation<ExecutionControl | null> {
    return unavailable();
  },
  *commitExecution(_request: CommitExecutionRequest): Operation<CommitExecutionResult> {
    return unavailable();
  },
  *putObject(_object: StoredExecutionObject): Operation<ExecutionObjectPointer> {
    return unavailable();
  },
  *getObject(_pointer: ExecutionObjectPointer): Operation<StoredExecutionObject | null> {
    return unavailable();
  },
  *appendJournalSegment(_segment: StoredPrivateSegment): Operation<PrivateSegmentPointer> {
    return unavailable();
  },
  *appendReplaySegment(_segment: StoredPrivateSegment): Operation<PrivateSegmentPointer> {
    return unavailable();
  },
  *readJournal(_task: {
    executionId: string;
    taskId: string;
    head: PrivateSegmentPointer | null;
  }): Operation<AsyncIterable<readonly Json[]>> {
    return unavailable();
  },
  *readReplay(_task: {
    executionId: string;
    taskId: string;
    head: PrivateSegmentPointer | null;
  }): Operation<AsyncIterable<readonly Json[]>> {
    return unavailable();
  },
});

export const ExecutionStoreApi = ExecutionStorePort.api;
/** Trusted current-scope facade; it preserves ExecutionStoreApi middleware. */
export type ExecutionStoreFacade = PortFacade<ExecutionStore>;
export const ExecutionStoreContext = ExecutionStorePort.context;

export function* useExecutionStore(): Operation<ExecutionStoreFacade> {
  // This is the API facade, not the raw backend. Every method still dispatches
  // through ExecutionStoreApi and its current-scope middleware chain.
  return yield* ExecutionStorePort.use();
}

export function installExecutionStore(store: ExecutionStore): Operation<void> {
  return ExecutionStorePort.installDriver(store);
}
