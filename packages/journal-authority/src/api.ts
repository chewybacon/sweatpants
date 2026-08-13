import { definePort } from "@sweatpants/foundation/port";
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

export function installExecutionStore(store: ExecutionStore): Operation<void> {
  return ExecutionStorePort.installDriver(store);
}
