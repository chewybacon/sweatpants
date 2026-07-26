import type { Json } from "@sweatpants/foundation";
import type {
  DurableReference,
  ExecutionId,
  ExecutionTreeSnapshot,
  TerminalCapsule,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";

export interface VersionedExecution {
  readonly revision: number;
  readonly record: ExecutionTreeSnapshot | TerminalCapsule;
}
export interface CommitExecutionRequest {
  readonly executionId: ExecutionId;
  readonly expectedRevision: number | null;
  readonly next: ExecutionTreeSnapshot | TerminalCapsule;
  readonly privateRecords: readonly Json[];
}
export type CommitExecutionResult =
  | { readonly status: "accepted"; readonly revision: number }
  | { readonly status: "conflict"; readonly actualRevision: number | null };
export interface AppendReplayRequest {
  readonly executionId: ExecutionId;
  readonly taskId: string;
  readonly previous: DurableReference | null;
  readonly entries: readonly Json[];
}
export interface ExecutionStore {
  loadExecution(executionId: ExecutionId): Operation<VersionedExecution | null>;
  commitExecution(request: CommitExecutionRequest): Operation<CommitExecutionResult>;
  putPayload(value: Json | Uint8Array): Operation<DurableReference>;
  getPayload(reference: DurableReference): Operation<Json | Uint8Array | null>;
  appendReplay(request: AppendReplayRequest): Operation<DurableReference>;
  readReplay(head: DurableReference | null): Operation<readonly Json[]>;
}
