import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";

export type DurableCounter = string;
export type Milliseconds = number;

export interface PrivateSegmentPointer {
  readonly segmentId: string;
  readonly lastSequence: DurableCounter;
}

export interface ExecutionObjectPointer {
  readonly objectId: string;
}

export interface ExecutionControl {
  readonly executionId: string;
  readonly controlRevision: DurableCounter;
  readonly ownerFence: DurableCounter;
  readonly status: "active" | "parked" | "cancelling" | "terminal";
  readonly rootTaskId: string;
  readonly stopGeneration: DurableCounter;
  readonly requestedDisposition: "cancelled" | "superseded" | null;
  readonly control: Json;
  readonly updatedAt: Milliseconds;
}

export interface StoredPrivateSegment {
  readonly segmentId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly previous: PrivateSegmentPointer | null;
  readonly firstSequence: DurableCounter;
  readonly lastSequence: DurableCounter;
  readonly entries: readonly Json[];
  readonly contentHash: string;
  readonly encodedBytes: number;
  readonly createdAt: Milliseconds;
}

export interface StoredExecutionObject {
  readonly objectId: string;
  readonly lifetimeScope: "execution" | "conversation";
  readonly scopeOwnerId: string;
  readonly objectKind: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly body: Json | Uint8Array;
  readonly createdAt: Milliseconds;
}

export interface CommitExecutionRequest {
  readonly executionId: string;
  readonly expectedControlRevision: DurableCounter | null;
  readonly expectedOwnerFence: DurableCounter;
  readonly nextControl: Omit<ExecutionControl, "controlRevision" | "updatedAt">;
  readonly journalSegments?: readonly StoredPrivateSegment[];
  readonly replaySegments?: readonly StoredPrivateSegment[];
  /** Execution-owned immutable objects published atomically with this control. */
  readonly objects?: readonly StoredExecutionObject[];
  readonly updatedAt: Milliseconds;
}

export type CommitExecutionResult =
  | { readonly status: "committed"; readonly control: ExecutionControl }
  | { readonly status: "control_conflict"; readonly current: ExecutionControl | null }
  | { readonly status: "stale_owner"; readonly current: ExecutionControl };

export interface ExecutionStore {
  loadControl(executionId: string): Operation<ExecutionControl | null>;
  commitExecution(request: CommitExecutionRequest): Operation<CommitExecutionResult>;
  putObject(object: StoredExecutionObject): Operation<ExecutionObjectPointer>;
  getObject(pointer: ExecutionObjectPointer): Operation<StoredExecutionObject | null>;
  /** Optional staging; only fenced control publication makes the segment authoritative. */
  appendJournalSegment(segment: StoredPrivateSegment): Operation<PrivateSegmentPointer>;
  /** Optional staging; only fenced control publication makes the segment authoritative. */
  appendReplaySegment(segment: StoredPrivateSegment): Operation<PrivateSegmentPointer>;
  readJournal(task: {
    readonly executionId: string;
    readonly taskId: string;
    readonly head: PrivateSegmentPointer | null;
  }): Operation<AsyncIterable<readonly Json[]>>;
  readReplay(task: {
    readonly executionId: string;
    readonly taskId: string;
    readonly head: PrivateSegmentPointer | null;
  }): Operation<AsyncIterable<readonly Json[]>>;
}

export type ExecutionStoreErrorCode =
  | "immutable_object_conflict"
  | "persisted_data_invalid"
  | "segment_entry_too_large";

export class ExecutionStoreError extends Error {
  constructor(
    readonly code: ExecutionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutionStoreError";
  }
}
