import type { Json } from "@sweatpants/foundation";
import type { OperationOutcome } from "@sweatpants/durable-effects/contract";

export type ExecutionId = string;
export type SessionId = string;
export type TurnId = string;
export type TaskId = string;
export type PullId = string;
export type DurableRevision = number;

export interface DurableReference {
  readonly id: string;
  readonly byteLength?: number;
  readonly version?: string;
  readonly integrity?: { readonly algorithm: string; readonly value: string };
}

export type StoredJson =
  | { readonly storage: "inline"; readonly value: Json }
  | { readonly storage: "reference"; readonly reference: DurableReference };

export interface ProgramIdentity {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export type PendingBoundary =
  | {
      readonly type: "effect";
      readonly pullId: PullId;
      readonly attemptId: string;
      readonly hostOwned: boolean;
    }
  | { readonly type: "child"; readonly pullId: PullId; readonly childTaskId: TaskId }
  | { readonly type: "elicit"; readonly pullId: PullId; readonly descriptor: Json };

export interface TaskControlState {
  readonly taskId: TaskId;
  readonly parentTaskId?: TaskId;
  readonly parentPullId?: PullId;
  readonly program: ProgramIdentity;
  readonly input: StoredJson;
  readonly route: Json;
  readonly status: "active" | "parked" | "cancelling";
  readonly actionIndex: number;
  readonly pullIndex: number;
  readonly emissionIndex: number;
  readonly replayHead: DurableReference | null;
  readonly pending: PendingBoundary | null;
}

export interface ProjectionFactEnvelope {
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: Json;
}

export interface ProjectionFrontier {
  readonly throughSequence: number;
  readonly facts: DurableReference | null;
}

export interface ExecutionTreeSnapshot {
  readonly format: "sweatpants.execution-tree.v1";
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly rootTaskId: TaskId;
  readonly rootProgram: ProgramIdentity;
  readonly tasks: readonly TaskControlState[];
  readonly runnableTaskIds: readonly TaskId[];
  readonly checkpoint: DurableReference | null;
  readonly unpublishedProjection: ProjectionFrontier;
}

export interface ParentReplayOutcome {
  readonly taskId: TaskId;
  readonly pullId: PullId;
  readonly childTaskId: TaskId;
  readonly outcome: OperationOutcome;
}

export interface TerminalCapsule {
  readonly type: "terminal";
  readonly format: "sweatpants.terminal-execution.v1";
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly rootTaskId: TaskId;
  readonly rootProgram: ProgramIdentity;
  readonly outcome: StoredJson;
  readonly disposition: "completed" | "failed" | "cancelled" | "superseded";
  readonly finalRevision: DurableRevision;
  readonly completedAt: number;
  readonly projection: ProjectionFrontier;
  readonly publication: "unpublished" | "published";
}

export interface ExecutionDecision<Result> {
  readonly next: ExecutionTreeSnapshot | TerminalCapsule;
  readonly result: Result;
  readonly privateRecords: readonly Json[];
  readonly projectionFacts: readonly Json[];
  readonly replayAppends: readonly ParentReplayOutcome[];
  readonly payloadWrites: readonly Json[];
}

export class InvalidExecutionTransition extends Error {
  readonly code = "invalid_transition";
  constructor(message: string) {
    super(message);
    this.name = "InvalidExecutionTransition";
  }
}
