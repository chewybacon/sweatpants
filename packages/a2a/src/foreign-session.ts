import { CrankError } from "@sweatpants/durable-execution";
import { call, sleep, type Operation } from "effection";

import {
  ForeignA2ATransportError,
  classifyForeignCancellation,
  type ForeignA2AClientPort,
} from "./foreign-client.ts";
import { validateForeignA2AInvocationPin } from "./foreign-discovery.ts";
import {
  assertConsistentForeignObservation,
  foreignA2AMessageDigest,
  foreignA2ATaskDigest,
} from "./foreign-validation.ts";
import {
  DURABLE_INVOCATION_EXTENSION_URI,
  type ForeignA2ACancelResult,
  type ForeignA2AContinueRequest,
  type ForeignA2AIndeterminate,
  type ForeignA2AInterruption,
  type ForeignA2AMessage,
  type ForeignA2ANormalizedState,
  type ForeignA2AObservationState,
  type ForeignA2ASendResult,
  type ForeignA2ASessionEvent,
  type ForeignA2AStartRequest,
  type ForeignA2ATask,
  type ForeignA2ATerminalResult,
} from "./foreign-task-types.ts";

export interface ForeignA2ASessionObservation {
  readonly event: "dispatch" | "observe" | "respond" | "cancel";
  readonly invocationId: string;
  readonly guarantee: ForeignA2AObservationState["pin"]["guarantee"]["level"];
  readonly interfaceUrl: string;
  readonly messageId?: string;
  readonly taskId?: string;
  readonly state?: ForeignA2ANormalizedState;
}
export interface ForeignA2ASessionOptions {
  readonly client: ForeignA2AClientPort;
  readonly onObservation?: (observation: ForeignA2ASessionObservation) => void;
  readonly polling?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    readonly multiplier?: number;
    readonly jitter?: number;
    readonly maxPolls?: number;
  };
  readonly random?: () => number;
}

/** Binding-neutral durable A2A task state machine. All mutable state is returned as JSON. */
export class ForeignA2ADurableSession {
  readonly #client: ForeignA2AClientPort;
  readonly #polling: Required<NonNullable<ForeignA2ASessionOptions["polling"]>>;
  readonly #random: () => number;
  readonly #onObservation: ((observation: ForeignA2ASessionObservation) => void) | undefined;

  constructor(options: ForeignA2ASessionOptions) {
    this.#client = options.client;
    this.#polling = {
      initialMs: options.polling?.initialMs ?? 500,
      maxMs: options.polling?.maxMs ?? 10_000,
      multiplier: options.polling?.multiplier ?? 1.8,
      jitter: options.polling?.jitter ?? 0.2,
      maxPolls: options.polling?.maxPolls ?? 10_000,
    };
    this.#random = options.random ?? Math.random;
    this.#onObservation = options.onObservation;
    validatePolling(this.#polling);
  }

  *start(request: ForeignA2AStartRequest): Operation<{
    state: ForeignA2AObservationState;
    event: ForeignA2ASessionEvent;
  }> {
    validateForeignA2AInvocationPin(request.pin);
    assertDuplicateRiskPolicy(request.pin);
    this.#report("dispatch", request.pin, request.message.messageId);
    assertFuture(request.pin.requestExpiresAt, "initial request");
    if (request.message.messageId !== request.pin.initialMessageId) {
      throw new CrankError("a2a_identity_mismatch", "Initial A2A message ID differs from its pin");
    }
    if (request.message.taskId || request.message.contextId) {
      throw new CrankError(
        "a2a_protocol_error",
        "Initial A2A message may not provide a task handle",
      );
    }
    const state: ForeignA2AObservationState = {
      pin: request.pin,
      observationDigests: {},
      initialMessageDigest: foreignA2AMessageDigest(request.message),
      continuationIndex: 0,
    };
    const dispatched = yield* this.#dispatchInitial(request);
    if ("indeterminate" in dispatched) {
      return { state, event: { type: "indeterminate", result: dispatched.indeterminate } };
    }
    return transitionFromSend(state, dispatched.result);
  }

  *observe(state: ForeignA2AObservationState): Operation<{
    state: ForeignA2AObservationState;
    event: ForeignA2ASessionEvent;
  }> {
    if (!state.binding) {
      throw new CrankError("a2a_task_unbound", "Cannot observe an unbound A2A invocation");
    }
    this.#report(
      "observe",
      state.pin,
      undefined,
      state.binding.taskId,
      state.lastTask?.status.state,
    );
    if (expired(state.pin.guarantee.taskExpiresAt)) {
      return {
        state,
        event: {
          type: "terminal",
          result: {
            status: "remote_state_expired",
            guarantee: state.pin.guarantee,
            taskId: state.binding.taskId,
            ...(state.binding.contextId ? { contextId: state.binding.contextId } : {}),
          },
        },
      };
    }
    try {
      if (this.#client.subscribeTask) {
        try {
          const stream = yield* this.#client.subscribeTask({
            pin: state.pin,
            taskId: state.binding.taskId,
          });
          const iterator = stream[Symbol.asyncIterator]();
          const next = yield* call(() => iterator.next());
          if (!next.done) {
            return transitionFromTask(state, next.value);
          }
        } catch {
          // Subscription is a latency optimization. Authenticated GetTask is
          // always the recovery baseline after stream loss.
        }
      }
      const task = yield* this.#client.getTask({ pin: state.pin, taskId: state.binding.taskId });
      return transitionFromTask(state, task);
    } catch (error) {
      if (
        error instanceof CrankError &&
        ["a2a_observation_conflict", "a2a_binding_conflict", "a2a_protocol_error"].includes(
          error.code,
        )
      ) {
        throw error;
      }
      if (error instanceof CrankError && error.code === "remote_state_expired") {
        return {
          state,
          event: {
            type: "terminal",
            result: {
              status: "remote_state_expired",
              guarantee: state.pin.guarantee,
              taskId: state.binding.taskId,
              ...(state.binding.contextId ? { contextId: state.binding.contextId } : {}),
            },
          },
        };
      }
      return {
        state,
        event: {
          type: "indeterminate",
          result: indeterminate(state, "observation", state.pin.initialMessageId, error, false),
        },
      };
    }
  }

  *respond(
    state: ForeignA2AObservationState,
    request: ForeignA2AContinueRequest,
  ): Operation<{ state: ForeignA2AObservationState; event: ForeignA2ASessionEvent }> {
    validateForeignA2AInvocationPin(request.pin);
    assertDuplicateRiskPolicy(request.pin);
    this.#report(
      "respond",
      request.pin,
      request.message.messageId,
      request.taskId,
      state.lastTask?.status.state,
    );
    assertContinuationGuarantee(request);
    if (!state.binding || request.taskId !== state.binding.taskId) {
      throw new CrankError("a2a_identity_mismatch", "Continuation does not target the bound task");
    }
    if (request.contextId !== state.binding.contextId) {
      throw new CrankError(
        "a2a_identity_mismatch",
        "Continuation context does not match the bound task",
      );
    }
    const expectedIndex = state.continuationIndex + 1;
    if (!request.message.messageId) {
      throw new CrankError(
        "a2a_identity_mismatch",
        "Continuation message requires a stable identity",
      );
    }
    const dispatched = yield* this.#dispatchContinuation(request);
    const advanced = { ...state, continuationIndex: expectedIndex };
    if ("indeterminate" in dispatched) {
      return {
        state: advanced,
        event: { type: "indeterminate", result: dispatched.indeterminate },
      };
    }
    return transitionFromSend(advanced, dispatched.result);
  }

  *cancel(state: ForeignA2AObservationState): Operation<ForeignA2ACancelResult> {
    this.#report(
      "cancel",
      state.pin,
      state.pin.initialMessageId,
      state.binding?.taskId,
      state.lastTask?.status.state,
    );
    if (state.binding) {
      try {
        const task = yield* this.#client.cancelTask({
          pin: state.pin,
          taskId: state.binding.taskId,
        });
        return classifyForeignCancellation(task);
      } catch (error) {
        return classifyForeignCancellation(
          error instanceof CrankError ? error : new CrankError("a2a_transport_lost"),
        );
      }
    }
    if (
      state.pin.guarantee.level !== "reconciled" ||
      !this.#client.resolveInvocation ||
      !this.#client.abortInvocation
    ) {
      return { status: "creation_indeterminate" };
    }
    const messageDigest = state.initialMessageDigest;
    try {
      const resolved = yield* this.#client.resolveInvocation({ pin: state.pin, messageDigest });
      if (resolved.status === "bound") {
        if (resolved.result.type === "message") {
          return { status: "already_terminal", task: directMessageTask(resolved.result.message) };
        }
        const task = yield* this.#client.cancelTask({
          pin: state.pin,
          taskId: resolved.result.task.id,
        });
        return classifyForeignCancellation(task);
      }
      if (resolved.status === "aborted") {
        return { status: "definitely_not_created", abortExpiresAt: resolved.expiresAt };
      }
      const aborted = yield* this.#client.abortInvocation({ pin: state.pin, messageDigest });
      if (aborted.status === "aborted") {
        return { status: "definitely_not_created", abortExpiresAt: aborted.expiresAt };
      }
      if (aborted.result.type === "message") {
        return { status: "already_terminal", task: directMessageTask(aborted.result.message) };
      }
      const task = yield* this.#client.cancelTask({
        pin: state.pin,
        taskId: aborted.result.task.id,
      });
      return classifyForeignCancellation(task);
    } catch {
      return { status: "transport_indeterminate" };
    }
  }

  *awaitResult(request: ForeignA2AStartRequest): Operation<ForeignA2ATerminalResult> {
    let { state, event } = yield* this.start(request);
    let polls = 0;
    let delay = this.#polling.initialMs;
    while (true) {
      if (event.type === "terminal") {
        return event.result;
      }
      if (event.type === "indeterminate") {
        return terminalIndeterminate(state, event.result);
      }
      if (event.type === "interruption") {
        return {
          status: "interrupted",
          guarantee: state.pin.guarantee,
          interruption: event.interruption,
          task: state.lastTask!,
        };
      }
      polls += 1;
      if (polls > this.#polling.maxPolls) {
        return terminalIndeterminate(
          state,
          indeterminate(
            state,
            "observation",
            request.message.messageId,
            new Error("poll budget exhausted"),
            false,
          ),
        );
      }
      const jitter = 1 + (this.#random() * 2 - 1) * this.#polling.jitter;
      yield* sleep(Math.max(1, Math.round(delay * jitter)));
      ({ state, event } = yield* this.observe(state));
      delay = Math.min(this.#polling.maxMs, delay * this.#polling.multiplier);
    }
  }

  #report(
    event: ForeignA2ASessionObservation["event"],
    pin: ForeignA2AObservationState["pin"],
    messageId?: string,
    taskId?: string,
    state?: ForeignA2ANormalizedState,
  ): void {
    this.#onObservation?.({
      event,
      invocationId: pin.invocationId,
      guarantee: pin.guarantee.level,
      interfaceUrl: pin.interface.url,
      ...(messageId ? { messageId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(state ? { state } : {}),
    });
  }

  *#dispatchInitial(
    request: ForeignA2AStartRequest,
  ): Operation<{ result: ForeignA2ASendResult } | { indeterminate: ForeignA2AIndeterminate }> {
    const attempts = boundedAttempts(request.maxDispatchAttempts);
    const messageDigest = foreignA2AMessageDigest(request.message);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return { result: yield* this.#client.sendInitial(request) };
      } catch (error) {
        if (!ambiguous(error)) {
          throw error;
        }
        if (request.pin.guarantee.level === "reconciled" && this.#client.resolveInvocation) {
          const resolution = yield* this.#client.resolveInvocation({
            pin: request.pin,
            messageDigest,
          });
          if (resolution.status === "bound") {
            return { result: resolution.result };
          }
          if (resolution.status === "aborted") {
            return {
              indeterminate: indeterminateFromPin(
                request.pin,
                "initial_dispatch",
                request.message.messageId,
                error,
                false,
              ),
            };
          }
          if (attempt < attempts) {
            continue;
          }
        } else if (request.pin.guarantee.level === "idempotent_messages" && attempt < attempts) {
          continue;
        } else if (request.pin.ambiguityPolicy === "retry_may_duplicate" && attempt < attempts) {
          continue;
        }
        return {
          indeterminate: indeterminateFromPin(
            request.pin,
            "initial_dispatch",
            request.message.messageId,
            error,
            true,
          ),
        };
      }
    }
    throw new CrankError("a2a_protocol_error", "Unreachable initial dispatch state");
  }

  *#dispatchContinuation(
    request: ForeignA2AContinueRequest,
  ): Operation<{ result: ForeignA2ASendResult } | { indeterminate: ForeignA2AIndeterminate }> {
    const attempts = boundedAttempts(request.maxDispatchAttempts);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return { result: yield* this.#client.sendContinuation(request) };
      } catch (error) {
        if (!ambiguous(error)) {
          throw error;
        }
        if (
          ["reconciled", "idempotent_messages"].includes(request.pin.guarantee.level) &&
          attempt < attempts
        ) {
          continue;
        }
        if (request.pin.ambiguityPolicy === "retry_may_duplicate" && attempt < attempts) {
          continue;
        }
        return {
          indeterminate: indeterminateFromPin(
            request.pin,
            "continuation_dispatch",
            request.message.messageId,
            error,
            false,
            request.taskId,
            request.contextId,
          ),
        };
      }
    }
    throw new CrankError("a2a_protocol_error", "Unreachable continuation dispatch state");
  }
}

function transitionFromSend(
  state: ForeignA2AObservationState,
  result: ForeignA2ASendResult,
): { state: ForeignA2AObservationState; event: ForeignA2ASessionEvent } {
  if (result.type === "message") {
    return {
      state,
      event: {
        type: "terminal",
        result: {
          status: "completed",
          guarantee: state.pin.guarantee,
          message: result.message,
          artifacts: [],
        },
      },
    };
  }
  return transitionFromTask(state, result.task);
}
function transitionFromTask(
  state: ForeignA2AObservationState,
  task: ForeignA2ATask,
): { state: ForeignA2AObservationState; event: ForeignA2ASessionEvent } {
  if (
    state.binding &&
    (state.binding.taskId !== task.id || state.binding.contextId !== task.contextId)
  ) {
    throw new CrankError("a2a_binding_conflict", "Remote task binding changed");
  }
  if (task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)) {
    const invocation = task.metadata[DURABLE_INVOCATION_EXTENSION_URI];
    if (
      invocation &&
      typeof invocation === "object" &&
      !Array.isArray(invocation) &&
      typeof invocation["invocationId"] === "string" &&
      invocation["invocationId"] !== state.pin.invocationId
    ) {
      throw new CrankError(
        "a2a_binding_conflict",
        "Operator-supplied task belongs to another invocation",
      );
    }
  }
  let observations = state.observationDigests;
  if (task.status.message) {
    observations = assertConsistentForeignObservation(
      observations,
      `message:${task.status.message.messageId}`,
      foreignA2AMessageDigest(task.status.message),
    );
  }
  const next: ForeignA2AObservationState = Object.freeze({
    ...state,
    binding: { taskId: task.id, ...(task.contextId ? { contextId: task.contextId } : {}) },
    lastTask: task,
    observationDigests: observations,
  });
  if (task.status.state === "input_required" || task.status.state === "auth_required") {
    const interruption = interruptionFrom(task);
    return { state: next, event: { type: "interruption", interruption } };
  }
  if (["completed", "failed", "canceled", "rejected"].includes(task.status.state)) {
    return { state: next, event: { type: "terminal", result: terminalFromTask(next, task) } };
  }
  return { state: next, event: { type: "progress", task, digest: foreignA2ATaskDigest(task) } };
}
function interruptionFrom(task: ForeignA2ATask): ForeignA2AInterruption {
  const message = task.status.message;
  if (task.status.state === "input_required") {
    if (!message) {
      throw new CrankError("a2a_protocol_error", "input-required task omitted status message");
    }
    return {
      type: "input_required",
      taskId: task.id,
      ...(task.contextId ? { contextId: task.contextId } : {}),
      request: message,
      requestDigest: foreignA2AMessageDigest(message),
      ...(task.metadata !== undefined ? { extensionMetadata: task.metadata } : {}),
    };
  }
  return {
    type: "auth_required",
    taskId: task.id,
    ...(task.contextId ? { contextId: task.contextId } : {}),
    ...(message ? { request: message, requestDigest: foreignA2AMessageDigest(message) } : {}),
    ...(task.metadata !== undefined ? { extensionMetadata: task.metadata } : {}),
  };
}
function terminalFromTask(
  state: ForeignA2AObservationState,
  task: ForeignA2ATask,
): ForeignA2ATerminalResult {
  return {
    status: task.status.state as "completed" | "failed" | "canceled" | "rejected",
    guarantee: state.pin.guarantee,
    taskId: task.id,
    ...(task.contextId ? { contextId: task.contextId } : {}),
    task,
    artifacts: task.artifacts,
  };
}
function terminalIndeterminate(
  state: ForeignA2AObservationState,
  value: ForeignA2AIndeterminate,
): ForeignA2ATerminalResult {
  const { type: _type, ...details } = value;
  return { status: "indeterminate", guarantee: state.pin.guarantee, ...details };
}
function indeterminate(
  state: ForeignA2AObservationState,
  phase: ForeignA2AIndeterminate["phase"],
  messageId: string,
  error: unknown,
  mayExist: boolean,
): ForeignA2AIndeterminate {
  return indeterminateFromPin(
    state.pin,
    phase,
    messageId,
    error,
    mayExist,
    state.binding?.taskId,
    state.binding?.contextId,
    state.lastTask?.status.state,
  );
}
function indeterminateFromPin(
  pin: ForeignA2AObservationState["pin"],
  phase: ForeignA2AIndeterminate["phase"],
  messageId: string,
  error: unknown,
  mayExist: boolean,
  taskId?: string,
  contextId?: string,
  lastConfirmedState?: ForeignA2ANormalizedState,
): ForeignA2AIndeterminate {
  return {
    type: "indeterminate",
    phase,
    invocationId: pin.invocationId,
    messageId,
    remoteTaskMayExist: mayExist,
    ...(taskId ? { taskId } : {}),
    ...(contextId ? { contextId } : {}),
    ...(lastConfirmedState ? { lastConfirmedState } : {}),
    code: error instanceof CrankError ? error.code : "a2a_transport_lost",
    message:
      error instanceof CrankError ? error.message : "Foreign A2A operation became indeterminate",
  };
}
function directMessageTask(message: ForeignA2AMessage): ForeignA2ATask {
  return {
    id: message.taskId ?? "direct-message",
    ...(message.contextId ? { contextId: message.contextId } : {}),
    status: { state: "completed", message },
    artifacts: [],
  };
}
function ambiguous(error: unknown): boolean {
  return error instanceof ForeignA2ATransportError && error.acceptanceUnknown;
}
function boundedAttempts(value = 3): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new CrankError("invalid_descriptor", "A2A dispatch attempts must be between one and ten");
  }
  return value;
}
function expired(value: string | undefined): boolean {
  return value !== undefined && Date.now() >= Date.parse(value);
}
function assertContinuationGuarantee(request: ForeignA2AContinueRequest): void {
  if (!["reconciled", "idempotent_messages"].includes(request.pin.guarantee.level)) {
    return;
  }
  const expiresAt =
    request.messageIdempotencyExpiresAt ?? request.pin.guarantee.messageIdempotencyExpiresAt;
  if (!expiresAt || Date.now() >= Date.parse(expiresAt)) {
    throw new CrankError(
      "a2a_guarantee_expired",
      "Message idempotency guarantee expired before continuation dispatch",
    );
  }
}
function assertFuture(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || Date.now() >= Date.parse(value)) {
    throw new CrankError("a2a_guarantee_expired", `${label} expired before dispatch`);
  }
}
function assertDuplicateRiskPolicy(pin: ForeignA2AObservationState["pin"]): void {
  if (pin.ambiguityPolicy === "retry_may_duplicate" && pin.duplicateRiskAcknowledged !== true) {
    throw new CrankError(
      "a2a_duplicate_risk_not_acknowledged",
      "retry_may_duplicate requires an acknowledged durable pin",
    );
  }
}
function validatePolling(value: Required<NonNullable<ForeignA2ASessionOptions["polling"]>>): void {
  if (
    !Number.isSafeInteger(value.initialMs) ||
    value.initialMs <= 0 ||
    !Number.isSafeInteger(value.maxMs) ||
    value.maxMs < value.initialMs ||
    !Number.isFinite(value.multiplier) ||
    value.multiplier < 1 ||
    !Number.isFinite(value.jitter) ||
    value.jitter < 0 ||
    value.jitter > 1 ||
    !Number.isSafeInteger(value.maxPolls) ||
    value.maxPolls <= 0
  ) {
    throw new CrankError("invalid_descriptor", "Invalid A2A polling policy");
  }
}
