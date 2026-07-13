import type { Operation, Stream } from "effection";

/** Canonical JSON value accepted across durable process and persistence boundaries. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Legacy crank effect pull descriptor retained at the compatibility seam. */
export type EffectPull = { kind: "effect"; effectId: string; input: Json };
/** Legacy crank user-input pull descriptor. */
export type ElicitPull = {
  kind: "elicit";
  effectId: string;
  input: { key: string; message: string; responseSchema: Json; context?: Json };
};
/** Legacy crank record-only effect descriptor. */
export type RecordPull = { kind: "record"; effectId: string; input: Json };
/** Legacy crank single-child invocation descriptor. */
export type InvokePull = { kind: "invoke"; programId: string; input: Json };
/** Legacy crank ordered multi-child invocation descriptor. */
export type AllPull = { kind: "all"; children: ReadonlyArray<{ programId: string; input: Json }> };
/** Legacy crank public emission descriptor. */
export type EmitPull = { kind: "emit"; eventType: string; payload: Json };
/** Closed pull algebra used by the replay-crank compatibility runtime. */
export type PullDescriptor = EffectPull | ElicitPull | RecordPull | InvokePull | AllPull | EmitPull;

/** Synchronous replay-crank generator yielding only pull descriptors. */
export type Program<T extends Json = Json> = Generator<PullDescriptor, T, unknown>;
/** Pure factory for a replay-crank program generator. */
export type ProgramFactory<I extends Json = Json, O extends Json = Json> = (input: I) => Program<O>;

/** Safe error DTO permitted in journals and public runtime results. */
export type SerializedApplicationError = { code: string; message: string; details?: Json };
/** Closed operation result algebra for replay-crank pulls. */
export type Result =
  | { status: "ok"; value: Json }
  | { status: "error"; error: SerializedApplicationError }
  | { status: "cancelled" };
/** Closed terminal task result algebra. */
export type TaskResult =
  | Result
  | {
      status: "diverged" | "version_mismatch";
      error: SerializedApplicationError;
    };

/** Idempotency-keyed external command algebra accepted by a session. */
export type SessionCommand =
  | { type: "send"; sessionId: string; commandId: string; message: Json }
  | { type: "respond"; sessionId: string; commandId: string; pullId: string; value: Json }
  | { type: "cancel_turn"; sessionId: string; commandId: string; turnId: string; reason?: string }
  | { type: "close_session"; sessionId: string; commandId: string; reason?: string };

/** Expected acknowledgement algebra for command acceptance and rejection. */
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

/** Exhaustive append-only replay-crank journal payload algebra. */
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

/** Journal payloads written only by a fenced execution owner. */
export type ExecutionJournalPayload = Exclude<JournalPayload, { type: "command" }>;

/** Offset-addressed journal envelope with optional execution-owner epoch. */
export type JournalRecord = {
  offset: number;
  eventId: string;
  sessionId: string;
  ownerEpoch?: number;
  payload: JournalPayload;
};

/** Persisted lease and runnable-state machine for one session. */
export type CoordinationRecord = {
  sessionId: string;
  epoch: number;
  ownerId?: string;
  leaseExpiresAt?: string;
  phase: "idle" | "runnable" | "running" | "parked" | "closed";
  journalHead: number;
  runnable: boolean;
};

/** Fenced execution lease granted to one activation owner. */
export type Lease = {
  sessionId: string;
  ownerId: string;
  epoch: number;
  leaseExpiresAt: string;
};

/** Expected result of atomically claiming session execution. */
export type ClaimResult = Lease | { status: "busy" | "closed" };
/** Expected result of a fenced journal append. */
export type AppendExecutionResult =
  | { status: "appended"; offset: number }
  | { status: "fenced" | "head_changed" };
/** Expected result of releasing or closing a fenced session. */
export type ReleaseResult = "parked" | "closed" | "head_changed" | "fenced";

/** Public replay projection event algebra; private journal records are excluded. */
export type PublicEvent =
  | { type: "turn_started" }
  | { type: "text_started"; messageId: string; attemptId: string }
  | { type: "text_delta"; messageId: string; attemptId: string; delta: string }
  | { type: "attempt_abandoned"; attemptId: string; messageId: string }
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

/** Public event paired with its durable source offset and identity. */
export type PublicEnvelope = {
  cursor: number;
  eventId: string;
  sessionId: string;
  turnId?: string;
  event: PublicEvent;
};

/** Scoped host-effect context with stable IDs, cancellation, and durable emission. */
export type EffectContext = {
  sessionId: string;
  turnId: string;
  taskId: string;
  pullId: string;
  attemptId: string;
  attemptIndex: number;
  emit(emission: Json): Operation<void>;
};

/** Effection-native or synchronous replay-crank host-effect handler. */
export type EffectHandler = (input: Json, context: EffectContext) => Operation<Json> | Json;
/** Symbolic replay-crank effect registry. */
export type EffectRegistry =
  | ReadonlyMap<string, EffectHandler>
  | Readonly<Record<string, EffectHandler>>;
/** Symbolic replay-crank child-program registry. */
export type ProgramRegistry =
  | ReadonlyMap<string, ProgramFactory>
  | Readonly<Record<string, ProgramFactory>>;

/** Atomic persistence and coordination port required by the replay-crank runtime. */
export interface CrankStore {
  /** Idempotently creates coordination state for a session. */
  ensureSession(sessionId: string): Operation<void>;
  /** Reads a defensive ordered journal snapshot. */
  readJournal(sessionId: string): Operation<JournalRecord[]>;
  /** Reads current fenced coordination state. */
  coordination(sessionId: string): Operation<CoordinationRecord>;
  /** Atomically claims an expired or runnable session lease. */
  claim(sessionId: string, ownerId: string, leaseMs?: number): Operation<ClaimResult>;
  /** Renews only the current unfenced lease. */
  renewLease(lease: Lease, leaseMs?: number): Operation<Lease | { status: "fenced" }>;
  /** Appends an idempotency-keyed external command atomically. */
  appendCommand(command: SessionCommand): Operation<CommandAck>;
  /** Appends one execution record under lease and expected-head fencing. */
  appendExecution(
    lease: Lease,
    expectedHead: number,
    payload: ExecutionJournalPayload,
  ): Operation<AppendExecutionResult>;
  /** Parks work and releases the current lease atomically. */
  parkAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult>;
  /** Closes coordination and releases the current lease atomically. */
  closeAndRelease(lease: Lease, expectedHead: number): Operation<ReleaseResult>;
  /** Lists sessions eligible for activation or recovery. */
  runnableSessions(): Operation<string[]>;
  /** Streams journal records strictly after an optional offset. */
  events(sessionId: string, afterOffset?: number): Stream<JournalRecord, void>;
}

/** Caller-visible outcome of one bounded replay-crank activation. */
export type ActivationOutcome =
  | { state: "closed"; turnId?: string }
  | { state: "parked"; turnId?: string; pullId?: string }
  | { state: "fenced" }
  | { state: "idle" };

/** Composition dependencies and policy for a replay-crank runtime. */
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

/** Scoped application service for activating runnable durable sessions. */
export interface CrankRuntime {
  /** Runs one bounded activation with lease ownership and structured cancellation. */
  activate(sessionId: string): Operation<ActivationOutcome>;
}

/** Session command and public-event API over a caller-owned CrankStore. */
export interface CrankSession {
  readonly id: string;
  /** Appends a new turn command idempotently. */
  send(message: Json, options: { commandId: string }): Operation<CommandAck>;
  /** Appends a response command for a pending pull idempotently. */
  respond(pullId: string, value: Json, options: { commandId: string }): Operation<CommandAck>;
  /** Appends cancellation for the current matching turn. */
  cancelTurn(
    turnId: string,
    options: { commandId: string; reason?: string },
  ): Operation<CommandAck>;
  /** Appends terminal session closure idempotently. */
  close(options: { commandId: string; reason?: string }): Operation<CommandAck>;
  /** Streams only public projected events after an optional cursor. */
  events(afterCursor?: number): Stream<PublicEnvelope, void>;
}

/** Stable runtime and boundary error-code algebra. */
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

/** A safely serializable runtime or boundary failure classified by {@link code}. */
export class CrankError extends Error {
  readonly _tag = "CrankError";

  constructor(
    readonly code: RuntimeErrorCode | (string & {}),
    message = code,
    readonly details?: Json,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CrankError";
  }
}

/** Carries an expected application failure returned by a durable pull. */
export class PullApplicationError extends Error {
  readonly _tag = "PullApplicationError";

  constructor(readonly applicationError: SerializedApplicationError) {
    super(applicationError.message);
    this.name = "PullApplicationError";
  }
}
