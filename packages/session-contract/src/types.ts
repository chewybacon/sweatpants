import type { Operation, Stream } from "effection";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type EffectPull = { kind: "effect"; effectId: string; input: Json };
export type ElicitPull = {
  kind: "elicit";
  effectId: string;
  input: { key: string; message: string; responseSchema: Json; context?: Json };
};
export type RecordPull = { kind: "record"; effectId: string; input: Json };
export type InvokePull = { kind: "invoke"; programId: string; input: Json };
export type AllPull = { kind: "all"; children: ReadonlyArray<{ programId: string; input: Json }> };
export type EmitPull = { kind: "emit"; eventType: string; payload: Json };
export type PullDescriptor = EffectPull | ElicitPull | RecordPull | InvokePull | AllPull | EmitPull;

export type Program<T extends Json = Json> = Generator<PullDescriptor, T, unknown>;
export type ProgramFactory<I extends Json = Json, O extends Json = Json> = (input: I) => Program<O>;

export type SerializedApplicationError = { code: string; message: string; details?: Json };
export type Result =
  | { status: "ok"; value: Json }
  | { status: "error"; error: SerializedApplicationError }
  | { status: "cancelled" };
export type TaskResult =
  | Result
  | {
      status: "diverged" | "version_mismatch";
      error: SerializedApplicationError;
    };

export type SessionCommand =
  | { type: "send"; sessionId: string; commandId: string; message: Json }
  | { type: "respond"; sessionId: string; commandId: string; pullId: string; value: Json }
  | { type: "cancel_turn"; sessionId: string; commandId: string; turnId: string; reason?: string }
  | { type: "close_session"; sessionId: string; commandId: string; reason?: string };

export type CommandAck =
  | { status: "accepted" | "duplicate"; commandId: string; offset: number }
  | {
      status: "not_pending";
      commandId: string;
      reason: "unknown" | "wrong_kind" | "reserved" | "resolved" | "cancelled";
    }
  | {
      status: "rejected";
      commandId: string;
      code: "session_closed" | "idempotency_conflict" | "invalid_command" | "payload_too_large";
    };

export type JournalPayload =
  | { type: "command"; command: SessionCommand }
  | {
      type: "turn_opened";
      turnId: string;
      turnSeq: number;
      taskId: string;
      commandId: string;
      programVersion: string;
      input: Json;
      inputSha: string;
    }
  | {
      type: "task_opened";
      turnId: string;
      taskId: string;
      parentTaskId: string;
      parentPullId: string;
      programId: string;
      input: Json;
      inputSha: string;
    }
  | {
      type: "pull_requested";
      turnId: string;
      taskId: string;
      pullIndex: number;
      pullId: string;
      descriptor: PullDescriptor;
      inputSha: string;
    }
  | {
      type: "pull_resolved";
      turnId: string;
      taskId: string;
      pullId: string;
      commandId?: string;
      result: Result;
    }
  | {
      type: "attempt_started";
      turnId: string;
      taskId: string;
      pullId: string;
      attemptIndex: number;
      attemptId: string;
    }
  | {
      type: "attempt_abandoned";
      turnId: string;
      taskId: string;
      pullId: string;
      attemptId: string;
      reason: "host_lost" | "lease_lost" | "retry" | "cancelled";
    }
  | {
      type: "durable_emission";
      turnId: string;
      taskId: string;
      pullId: string;
      attemptId: string;
      sequence: number;
      emission: Json;
    }
  | { type: "task_closed"; turnId: string; taskId: string; commandId?: string; result: TaskResult }
  | { type: "session_closed"; commandId: string; reason?: string };

export type JournalRecord = {
  offset: number;
  eventId: string;
  sessionId: string;
  ownerEpoch?: number;
  payload: JournalPayload;
};

export type CoordinationRecord = {
  sessionId: string;
  epoch: number;
  ownerId?: string;
  leaseExpiresAt?: string;
  phase: "idle" | "runnable" | "running" | "parked" | "closed";
  journalHead: number;
  runnable: boolean;
};

export type Lease = {
  sessionId: string;
  ownerId: string;
  epoch: number;
  leaseExpiresAt: string;
};

export type ClaimResult = Lease | { status: "busy" | "closed" };
export type AppendExecutionResult =
  | { status: "appended"; offset: number }
  | { status: "fenced" | "head_changed" };
export type ReleaseResult = "parked" | "closed" | "head_changed" | "fenced";

export type PublicEvent =
  | { type: "turn_started" }
  | { type: "text_started"; messageId: string; attemptId: string }
  | { type: "text_delta"; messageId: string; attemptId: string; delta: string }
  | { type: "attempt_abandoned"; attemptId: string }
  | { type: "message_committed"; message: Json }
  | { type: "tool_started"; toolCallId: string; name: string; input?: Json }
  | { type: "tool_completed"; toolCallId: string; result?: Json }
  | {
      type: "input_requested";
      pullId: string;
      key: string;
      message: string;
      responseSchema: Json;
      context?: Json;
    }
  | { type: "input_resolved"; pullId: string }
  | {
      type: "turn_finished";
      outcome: "completed" | "cancelled" | "error";
      code?: string;
      message?: string;
    }
  | { type: "session_closed"; reason?: string };

export type PublicEnvelope = {
  cursor: number;
  eventId: string;
  sessionId: string;
  turnId?: string;
  event: PublicEvent;
};

export type EffectContext = {
  sessionId: string;
  turnId: string;
  taskId: string;
  pullId: string;
  attemptId: string;
  attemptIndex: number;
  emit(emission: Json): Operation<void>;
};

export type EffectHandler = (input: Json, context: EffectContext) => Operation<Json> | Json;
export type EffectRegistry =
  | ReadonlyMap<string, EffectHandler>
  | Readonly<Record<string, EffectHandler>>;
export type ProgramRegistry =
  | ReadonlyMap<string, ProgramFactory>
  | Readonly<Record<string, ProgramFactory>>;

export interface CrankStore {
  ensureSession(sessionId: string): Operation<void>;
  readJournal(sessionId: string): Operation<JournalRecord[]>;
  coordination(sessionId: string): Operation<CoordinationRecord>;
  claim(sessionId: string, ownerId: string, leaseMs?: number): Operation<ClaimResult>;
  appendCommand(command: SessionCommand): Operation<CommandAck>;
  appendExecution(
    lease: Lease,
    expectedHead: number,
    payload: JournalPayload,
  ): Operation<AppendExecutionResult>;
  parkAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult>;
  closeAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult>;
  runnableSessions(): Operation<string[]>;
  events(sessionId: string, afterOffset?: number): Stream<JournalRecord, void>;
}

export type ActivationOutcome =
  | { state: "closed"; turnId?: string }
  | { state: "parked"; turnId?: string; pullId?: string }
  | { state: "fenced" }
  | { state: "idle" };

export type CrankRuntimeOptions = {
  store: CrankStore;
  rootProgram: ProgramFactory;
  programVersion: string;
  effects?: EffectRegistry;
  programs?: ProgramRegistry;
  ownerId?: () => string;
  leaseMs?: number;
  restartAfterResolution?: boolean;
};

export interface CrankRuntime {
  activate(sessionId: string): Operation<ActivationOutcome>;
}

export interface CrankSession {
  readonly id: string;
  send(message: Json, options: { commandId: string }): Operation<CommandAck>;
  respond(pullId: string, value: Json, options: { commandId: string }): Operation<CommandAck>;
  cancelTurn(
    turnId: string,
    options: { commandId: string; reason?: string },
  ): Operation<CommandAck>;
  close(options: { commandId: string; reason?: string }): Operation<CommandAck>;
  events(afterCursor?: number): Stream<PublicEnvelope, void>;
}

export type RuntimeErrorCode =
  | "invalid_command"
  | "idempotency_conflict"
  | "session_closed"
  | "unknown_pull"
  | "wrong_pull_kind"
  | "pull_not_pending"
  | "unknown_target"
  | "invalid_journal"
  | "nondeterminism_detected"
  | "version_mismatch"
  | "ownership_fenced"
  | "payload_too_large"
  | "effect_error"
  | "runtime_error"
  | "invalid_pull";

export class CrankError extends Error {
  constructor(
    readonly code: RuntimeErrorCode | (string & {}),
    message = code,
    readonly details?: Json,
  ) {
    super(message);
    this.name = "CrankError";
  }
}

export class PullApplicationError extends Error {
  constructor(readonly applicationError: SerializedApplicationError) {
    super(applicationError.message);
    this.name = "PullApplicationError";
  }
}
