import { createQueue, spawn, type Operation } from "effection";

import { canonicalSnapshot, stableOpaqueId } from "./canonical.ts";
import {
  buildReplayIndex,
  descriptorFingerprint,
  descriptorIdentity,
  resultEquals,
  validateJournal,
  type ReplayIndex,
} from "./journal.ts";
import { recordProducerFor } from "./pulls.ts";
import {
  CrankError,
  PullApplicationError,
  type ActivationOutcome,
  type CrankRuntime,
  type CrankRuntimeOptions,
  type EffectContext,
  type EffectHandler,
  type JournalPayload,
  type JournalRecord,
  type Json,
  type Lease,
  type ProgramFactory,
  type PullDescriptor,
  type Result,
  type SessionCommand,
  type TaskResult,
} from "./types.ts";

type ActiveTurn = Extract<JournalPayload, { type: "turn_opened" }>;
type RunState = {
  options: CrankRuntimeOptions;
  lease: Lease;
  records: JournalRecord[];
  index: ReplayIndex;
  turn: ActiveTurn;
  runningVersion: string;
};
type TaskRun = { result: Result } | { parked: true; pullId: string };

class RestartActivation extends Error {}
class FencedActivation extends Error {}
class Divergence extends Error {
  constructor(
    readonly details: {
      taskId: string;
      pullIndex: number;
      expectedIdentity?: string;
      actualIdentity?: string;
      expectedSha?: string;
      actualSha?: string;
    },
  ) {
    super("strict replay mismatch");
  }
}

export function createCrankRuntime(options: CrankRuntimeOptions): CrankRuntime {
  if (!options.programVersion)
    throw new CrankError("invalid_command", "programVersion must be non-empty");
  return {
    *activate(sessionId: string): Operation<ActivationOutcome> {
      yield* options.store.ensureSession(sessionId);
      const ownerId =
        options.ownerId?.() ??
        `owner:${stableOpaqueId("activation", [sessionId, Date.now(), Math.random()] as unknown as Json)}`;
      const claim = yield* options.store.claim(sessionId, ownerId, options.leaseMs);
      if ("status" in claim)
        return claim.status === "closed" ? { state: "closed" } : { state: "fenced" };
      const lease = claim;

      try {
        while (true) {
          let records = yield* options.store.readJournal(sessionId);
          validateJournal(records);
          if (records.some((record) => record.payload.type === "session_closed")) {
            yield* releaseClosed(options, lease, records.length);
            return { state: "closed" };
          }

          let turn = findActiveTurn(records);
          const closeCommand = unconsumedCommand(records, "close_session");
          if (!turn) {
            if (closeCommand) {
              records = yield* appendRaw(options, lease, records, {
                type: "session_closed",
                commandId: closeCommand.commandId,
                ...(closeCommand.reason !== undefined ? { reason: closeCommand.reason } : {}),
              });
              yield* releaseClosed(options, lease, records.length);
              return { state: "closed" };
            }
            const send = nextUnconsumedSend(records);
            if (!send) {
              const released = yield* options.store.parkAndRelease(lease, records.length);
              if (released === "fenced") return { state: "fenced" };
              if (released === "head_changed") continue;
              return { state: "idle" };
            }
            const turnSeq = records.filter(
              (record) => record.payload.type === "turn_opened",
            ).length;
            const turnId = `turn-${turnSeq}`;
            const input = canonicalSnapshot(send.message);
            records = yield* appendRaw(options, lease, records, {
              type: "turn_opened",
              turnId,
              turnSeq,
              taskId: `${turnId}/root`,
              commandId: send.commandId,
              programVersion: options.programVersion,
              input: input.value,
              inputSha: input.sha,
            });
            turn = findActiveTurn(records)!;
          }

          const state: RunState = {
            options,
            lease,
            records,
            index: buildReplayIndex(records, turn.turnId),
            turn,
            runningVersion: options.programVersion,
          };

          try {
            const cancel = cancellationFor(records, turn.turnId);
            const closing = closeCommand ?? unconsumedCommand(records, "close_session");
            const run = yield* runTask(
              state,
              turn.taskId,
              turn.input,
              options.rootProgram,
              Boolean(cancel || closing),
            );
            if ("parked" in run) {
              const released = yield* options.store.parkAndRelease(lease, state.records.length);
              if (released === "fenced") return { state: "fenced" };
              if (released === "head_changed") continue;
              return { state: "parked", turnId: turn.turnId, pullId: run.pullId };
            }

            if (closing) {
              if (!state.records.some((record) => record.payload.type === "session_closed")) {
                state.records = yield* append(state, {
                  type: "session_closed",
                  commandId: closing.commandId,
                  ...(closing.reason !== undefined ? { reason: closing.reason } : {}),
                });
              }
              yield* releaseClosed(options, lease, state.records.length);
              return { state: "closed", turnId: turn.turnId };
            }
            // Run to quiescence: queued sends are opened by the next iteration.
            continue;
          } catch (error) {
            if (error instanceof RestartActivation) continue;
            if (error instanceof FencedActivation) return { state: "fenced" };
            if (error instanceof Divergence) {
              const mismatchStatus =
                turn.programVersion === options.programVersion ? "diverged" : "version_mismatch";
              const code =
                mismatchStatus === "diverged" ? "nondeterminism_detected" : "version_mismatch";
              const details = canonicalSnapshot({
                taskId: error.details.taskId,
                pullIndex: error.details.pullIndex,
                expectedIdentity: error.details.expectedIdentity ?? null,
                actualIdentity: error.details.actualIdentity ?? null,
                expectedSha: error.details.expectedSha ?? null,
                actualSha: error.details.actualSha ?? null,
                recordedVersion: turn.programVersion,
                runningVersion: options.programVersion,
              }).value;
              const result: TaskResult = {
                status: mismatchStatus,
                error: { code, message: "Strict replay diverged", details },
              };
              const openTasks = openedUnclosedTasks(state.records, turn.turnId);
              for (const taskId of openTasks.sort((left, right) => right.length - left.length)) {
                state.records = yield* append(state, {
                  type: "task_closed",
                  turnId: turn.turnId,
                  taskId,
                  result,
                });
              }
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof FencedActivation) return { state: "fenced" };
        throw error;
      }
    },
  };
}

function* runTask(
  state: RunState,
  taskId: string,
  input: Json,
  factory: ProgramFactory,
  forceCancel: boolean,
): Operation<TaskRun> {
  const recordedPulls = state.index.pulls.get(taskId) ?? [];
  const recordedClose = state.index.closes.get(taskId);
  let generator: ReturnType<ProgramFactory>;
  try {
    generator = factory(input);
  } catch (error) {
    return yield* closeErroredTask(state, taskId, error);
  }
  let step: IteratorResult<PullDescriptor, Json>;
  try {
    step = generator.next();
  } catch (error) {
    return yield* closeErroredTask(state, taskId, error);
  }
  let pullIndex = 0;
  let childOrdinal = 0;
  let unwinding = false;

  while (!step.done) {
    const liveDescriptor = step.value;
    const descriptor = snapshotDescriptor(liveDescriptor);
    const pullId = stablePullId(state.lease.sessionId, state.turn.turnId, taskId, pullIndex);
    const expected = recordedPulls[pullIndex];
    if (expected)
      assertReplayMatch(
        taskId,
        pullIndex,
        descriptor,
        expected.request.descriptor,
        expected.request.inputSha,
      );

    if (expected?.resolution) {
      pullIndex += 1;
      childOrdinal += childCount(descriptor);
      try {
        step = resumeGenerator(generator, expected.resolution.result);
      } catch (error) {
        return yield* closeErroredTask(state, taskId, error);
      }
      continue;
    }

    const cancel =
      forceCancel ||
      cancellationFor(state.records, state.turn.turnId) !== undefined ||
      unconsumedCommand(state.records, "close_session") !== undefined;
    if (cancel && !unwinding) {
      if (expected) {
        if (descriptor.kind === "invoke" || descriptor.kind === "all") {
          yield* cancelDescriptorChildren(state, taskId, pullId, descriptor, childOrdinal);
        }
        state.records = yield* append(state, {
          type: "pull_resolved",
          turnId: state.turn.turnId,
          taskId,
          pullId,
          result: { status: "cancelled" },
        });
        pullIndex += 1;
        childOrdinal += childCount(descriptor);
      }
      unwinding = true;
      try {
        step = generator.return(undefined as unknown as Json);
      } catch (error) {
        return yield* closeErroredTask(state, taskId, error);
      }
      continue;
    }

    if (!expected) {
      state.records = yield* append(state, {
        type: "pull_requested",
        turnId: state.turn.turnId,
        taskId,
        pullIndex,
        pullId,
        descriptor,
        inputSha: descriptorFingerprint(descriptor),
      });
    }

    const outcome = yield* resolvePull(
      state,
      taskId,
      pullIndex,
      pullId,
      descriptor,
      liveDescriptor,
      childOrdinal,
    );
    childOrdinal += childCount(descriptor);
    if ("parked" in outcome) return outcome;
    pullIndex += 1;
    if (state.options.restartAfterResolution) throw new RestartActivation();
    try {
      step = resumeGenerator(generator, outcome.result);
    } catch (error) {
      return yield* closeErroredTask(state, taskId, error);
    }
  }

  if (pullIndex < recordedPulls.length) {
    throw new Divergence({
      taskId,
      pullIndex,
      expectedIdentity: descriptorIdentity(recordedPulls[pullIndex]!.request.descriptor),
    });
  }
  const finalCancellation = cancellationFor(state.records, state.turn.turnId);
  let result: Result;
  if (unwinding || forceCancel || finalCancellation) result = { status: "cancelled" };
  else result = { status: "ok", value: canonicalSnapshot(step.value).value };
  if (recordedClose) {
    if (!taskResultEquals(recordedClose.result, result))
      throw new Divergence({ taskId, pullIndex });
    return { result: recordedClose.result as Result };
  }
  const cancellation = taskId === state.turn.taskId ? finalCancellation : undefined;
  state.records = yield* append(state, {
    type: "task_closed",
    turnId: state.turn.turnId,
    taskId,
    ...(cancellation && result.status === "cancelled" ? { commandId: cancellation.commandId } : {}),
    result,
  });
  return { result };
}

function* resolvePull(
  state: RunState,
  taskId: string,
  pullIndex: number,
  pullId: string,
  descriptor: PullDescriptor,
  liveDescriptor: PullDescriptor,
  childOrdinal: number,
): Operation<{ result: Result } | { parked: true; pullId: string }> {
  switch (descriptor.kind) {
    case "elicit": {
      const response = responseFor(state.records, pullId);
      if (!response) return { parked: true, pullId };
      const result: Result = { status: "ok", value: canonicalSnapshot(response.value).value };
      state.records = yield* append(state, {
        type: "pull_resolved",
        turnId: state.turn.turnId,
        taskId,
        pullId,
        commandId: response.commandId,
        result,
      });
      return { result };
    }
    case "invoke": {
      const factory = lookup(state.options.programs, descriptor.programId);
      if (!factory)
        return yield* resolveError(
          state,
          taskId,
          pullId,
          "unknown_target",
          `Unknown program ${descriptor.programId}`,
        );
      const childTaskId = `${taskId}.${childOrdinal}`;
      yield* ensureChildOpen(
        state,
        childTaskId,
        taskId,
        pullId,
        descriptor.programId,
        descriptor.input,
      );
      const child = yield* runTask(state, childTaskId, descriptor.input, factory, false);
      if ("parked" in child) return child;
      state.records = yield* append(state, {
        type: "pull_resolved",
        turnId: state.turn.turnId,
        taskId,
        pullId,
        result: child.result,
      });
      return { result: child.result };
    }
    case "all": {
      if (descriptor.children.length === 0) {
        const result: Result = { status: "ok", value: [] };
        state.records = yield* append(state, {
          type: "pull_resolved",
          turnId: state.turn.turnId,
          taskId,
          pullId,
          result,
        });
        return { result };
      }
      const children = descriptor.children.map((child, index) => ({
        ...child,
        taskId: `${taskId}.${childOrdinal + index}`,
        factory: lookup(state.options.programs, child.programId),
      }));
      const unknown = children.find((child) => !child.factory);
      if (unknown)
        return yield* resolveError(
          state,
          taskId,
          pullId,
          "unknown_target",
          `Unknown program ${unknown.programId}`,
        );
      // All identities/open records are committed before the first child executes.
      for (const child of children)
        yield* ensureChildOpen(state, child.taskId, taskId, pullId, child.programId, child.input);
      const completions = createQueue<
        { index: number; run: TaskRun } | { index: number; error: unknown },
        void
      >();
      for (const [index, child] of children.entries()) {
        yield* spawn(function* () {
          try {
            completions.add({
              index,
              run: yield* runTask(state, child.taskId, child.input, child.factory!, false),
            });
          } catch (error) {
            completions.add({ index, error });
          }
        });
      }

      const outcomes: Array<TaskRun | undefined> = Array.from({ length: children.length });
      for (let completed = 0; completed < children.length; completed += 1) {
        const next = yield* completions.next();
        if (next.done) throw new CrankError("runtime_error", "all completion queue closed");
        if ("error" in next.value) throw next.value.error;
        outcomes[next.value.index] = next.value.run;
      }

      const failedIndex = outcomes.findIndex(
        (outcome) => outcome && "result" in outcome && outcome.result.status !== "ok",
      );
      if (failedIndex >= 0) {
        const failure = outcomes[failedIndex]!;
        if (!("result" in failure)) throw new CrankError("runtime_error");
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const sibling = children[index]!;
          if (
            !state.records.some(
              (record) =>
                record.payload.type === "task_closed" && record.payload.taskId === sibling.taskId,
            )
          ) {
            yield* runTask(state, sibling.taskId, sibling.input, sibling.factory!, true);
          }
        }
        state.records = yield* append(state, {
          type: "pull_resolved",
          turnId: state.turn.turnId,
          taskId,
          pullId,
          result: failure.result,
        });
        return { result: failure.result };
      }

      const parked = outcomes.find((outcome): outcome is { parked: true; pullId: string } =>
        Boolean(outcome && "parked" in outcome),
      );
      if (parked) return parked;

      const results = outcomes.map((outcome) => {
        if (!outcome || !("result" in outcome) || outcome.result.status !== "ok") {
          throw new CrankError("runtime_error", "all child did not produce a value");
        }
        return outcome.result.value;
      });
      const result: Result = { status: "ok", value: results };
      state.records = yield* append(state, {
        type: "pull_resolved",
        turnId: state.turn.turnId,
        taskId,
        pullId,
        result,
      });
      return { result };
    }
    case "effect":
    case "record":
    case "emit":
      return yield* executeAutomatic(state, taskId, pullIndex, pullId, descriptor, liveDescriptor);
  }
}

function* executeAutomatic(
  state: RunState,
  taskId: string,
  _pullIndex: number,
  pullId: string,
  descriptor: Extract<PullDescriptor, { kind: "effect" | "record" | "emit" }>,
  liveDescriptor: PullDescriptor,
): Operation<{ result: Result }> {
  const attempts = state.records
    .filter(
      (record) => record.payload.type === "attempt_started" && record.payload.pullId === pullId,
    )
    .map((record) => record.payload as Extract<JournalPayload, { type: "attempt_started" }>);
  const abandonments = new Set(
    state.records
      .filter(
        (record) => record.payload.type === "attempt_abandoned" && record.payload.pullId === pullId,
      )
      .map(
        (record) =>
          (record.payload as Extract<JournalPayload, { type: "attempt_abandoned" }>).attemptId,
      ),
  );
  const previous = attempts.at(-1);
  if (previous && !abandonments.has(previous.attemptId)) {
    state.records = yield* append(state, {
      type: "attempt_abandoned",
      turnId: state.turn.turnId,
      taskId,
      pullId,
      attemptId: previous.attemptId,
      reason: "retry",
    });
  }
  const attemptIndex = attempts.length;
  const attemptId = `${pullId}:attempt-${attemptIndex}`;
  state.records = yield* append(state, {
    type: "attempt_started",
    turnId: state.turn.turnId,
    taskId,
    pullId,
    attemptIndex,
    attemptId,
  });
  let sequence = 0;
  const context: EffectContext = {
    sessionId: state.lease.sessionId,
    turnId: state.turn.turnId,
    taskId,
    pullId,
    attemptId,
    attemptIndex,
    emit: function* (emission: Json): Operation<void> {
      const snapshot = canonicalSnapshot(emission);
      state.records = yield* append(state, {
        type: "durable_emission",
        turnId: state.turn.turnId,
        taskId,
        pullId,
        attemptId,
        sequence: sequence++,
        emission: snapshot.value,
      });
    },
  };

  let result: Result;
  try {
    if (descriptor.kind === "emit") {
      yield* context.emit({ type: descriptor.eventType, payload: descriptor.payload });
      result = { status: "ok", value: null };
    } else {
      const producer = descriptor.kind === "record" ? recordProducerFor(liveDescriptor) : undefined;
      const handler = producer
        ? (input: Json, ctx: EffectContext) => producer(input, { pullId: ctx.pullId })
        : lookup(state.options.effects, descriptor.effectId);
      if (!handler) {
        result = {
          status: "error",
          error: { code: "unknown_target", message: `Unknown effect ${descriptor.effectId}` },
        };
      } else {
        const value = yield* runHandler(handler, descriptor.input, context);
        result = { status: "ok", value: canonicalSnapshot(value).value };
      }
    }
  } catch (error) {
    if (
      error instanceof FencedActivation ||
      (error instanceof CrankError && error.code === "ownership_fenced")
    )
      throw error;
    result = { status: "error", error: serializeError(error) };
  }
  state.records = yield* append(state, {
    type: "pull_resolved",
    turnId: state.turn.turnId,
    taskId,
    pullId,
    result,
  });
  return { result };
}

function* ensureChildOpen(
  state: RunState,
  taskId: string,
  parentTaskId: string,
  parentPullId: string,
  programId: string,
  input: Json,
): Operation<void> {
  const existing = state.records.find(
    (record) => record.payload.type === "task_opened" && record.payload.taskId === taskId,
  );
  const snapshot = canonicalSnapshot(input);
  if (existing) {
    const opened = existing.payload as Extract<JournalPayload, { type: "task_opened" }>;
    if (
      opened.parentTaskId !== parentTaskId ||
      opened.parentPullId !== parentPullId ||
      opened.programId !== programId ||
      opened.inputSha !== snapshot.sha
    ) {
      throw new Divergence({
        taskId: parentTaskId,
        pullIndex: -1,
        expectedIdentity: opened.programId,
        actualIdentity: programId,
        expectedSha: opened.inputSha,
        actualSha: snapshot.sha,
      });
    }
    return;
  }
  state.records = yield* append(state, {
    type: "task_opened",
    turnId: state.turn.turnId,
    taskId,
    parentTaskId,
    parentPullId,
    programId,
    input: snapshot.value,
    inputSha: snapshot.sha,
  });
}

function* cancelDescriptorChildren(
  state: RunState,
  parentTaskId: string,
  parentPullId: string,
  descriptor: Extract<PullDescriptor, { kind: "invoke" | "all" }>,
  childOrdinal: number,
): Operation<void> {
  const children =
    descriptor.kind === "invoke"
      ? [{ programId: descriptor.programId, input: descriptor.input }]
      : descriptor.children;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    const factory = lookup(state.options.programs, child.programId);
    if (!factory) continue;
    const taskId = `${parentTaskId}.${childOrdinal + index}`;
    yield* ensureChildOpen(state, taskId, parentTaskId, parentPullId, child.programId, child.input);
    if (
      !state.records.some(
        (record) => record.payload.type === "task_closed" && record.payload.taskId === taskId,
      )
    ) {
      yield* runTask(state, taskId, child.input, factory, true);
    }
  }
}

function* closeErroredTask(state: RunState, taskId: string, error: unknown): Operation<TaskRun> {
  const result: Result =
    error instanceof PullApplicationError
      ? { status: "error", error: error.applicationError }
      : { status: "error", error: serializeError(error) };
  const close = state.index.closes.get(taskId);
  if (close) {
    if (!taskResultEquals(close.result, result))
      throw new Divergence({ taskId, pullIndex: state.index.pulls.get(taskId)?.length ?? 0 });
    return { result: close.result as Result };
  }
  state.records = yield* append(state, {
    type: "task_closed",
    turnId: state.turn.turnId,
    taskId,
    result,
  });
  return { result };
}

function* resolveError(
  state: RunState,
  taskId: string,
  pullId: string,
  code: string,
  message: string,
): Operation<{ result: Result }> {
  const result: Result = { status: "error", error: { code, message } };
  state.records = yield* append(state, {
    type: "pull_resolved",
    turnId: state.turn.turnId,
    taskId,
    pullId,
    result,
  });
  return { result };
}

function* runHandler(handler: EffectHandler, input: Json, context: EffectContext): Operation<Json> {
  const result = handler(input, context);
  if (isOperation(result)) return yield* result;
  return result;
}

function resumeGenerator(
  generator: ReturnType<ProgramFactory>,
  result: Result,
): IteratorResult<PullDescriptor, Json> {
  if (result.status === "ok") return generator.next(result.value);
  if (result.status === "error") return generator.throw(new PullApplicationError(result.error));
  return generator.return(undefined as unknown as Json);
}

function assertReplayMatch(
  taskId: string,
  pullIndex: number,
  actual: PullDescriptor,
  expected: PullDescriptor,
  expectedSha: string,
): void {
  const actualSha = descriptorFingerprint(actual);
  const expectedIdentity = descriptorIdentity(expected);
  const actualIdentity = descriptorIdentity(actual);
  const compoundMatches =
    actual.kind !== "all" ||
    expected.kind !== "all" ||
    (actual.children.length === expected.children.length &&
      actual.children.every(
        (child, index) => child.programId === expected.children[index]?.programId,
      ));
  if (
    actual.kind !== expected.kind ||
    expectedIdentity !== actualIdentity ||
    expectedSha !== actualSha ||
    !compoundMatches
  ) {
    throw new Divergence({
      taskId,
      pullIndex,
      expectedIdentity,
      actualIdentity,
      expectedSha,
      actualSha,
    });
  }
}

function snapshotDescriptor(descriptor: PullDescriptor): PullDescriptor {
  if (!descriptor || typeof descriptor !== "object") throw new CrankError("invalid_pull");
  switch (descriptor.kind) {
    case "effect":
      return {
        kind: "effect",
        effectId: requireId(descriptor.effectId),
        input: canonicalSnapshot(descriptor.input).value,
      };
    case "elicit":
      return {
        kind: "elicit",
        effectId: requireId(descriptor.effectId),
        input: canonicalSnapshot(descriptor.input).value as Extract<
          PullDescriptor,
          { kind: "elicit" }
        >["input"],
      };
    case "record":
      return {
        kind: "record",
        effectId: requireId(descriptor.effectId),
        input: canonicalSnapshot(descriptor.input).value,
      };
    case "invoke":
      return {
        kind: "invoke",
        programId: requireId(descriptor.programId),
        input: canonicalSnapshot(descriptor.input).value,
      };
    case "all":
      return {
        kind: "all",
        children: descriptor.children.map((child) => ({
          programId: requireId(child.programId),
          input: canonicalSnapshot(child.input).value,
        })),
      };
    case "emit":
      return {
        kind: "emit",
        eventType: requireId(descriptor.eventType),
        payload: canonicalSnapshot(descriptor.payload).value,
      };
    default:
      throw new CrankError("invalid_pull", "Unknown pull kind");
  }
}

function* append(state: RunState, payload: JournalPayload): Operation<JournalRecord[]> {
  state.records = yield* appendRaw(state.options, state.lease, state.records, payload);
  return state.records;
}

function* appendRaw(
  options: CrankRuntimeOptions,
  lease: Lease,
  records: JournalRecord[],
  payload: JournalPayload,
): Operation<JournalRecord[]> {
  while (true) {
    const result = yield* options.store.appendExecution(lease, records.length, payload);
    if (result.status === "fenced") throw new FencedActivation();
    if (result.status === "head_changed") {
      records = yield* options.store.readJournal(lease.sessionId);
      validateJournal(records);
      continue;
    }
    if (result.status !== "appended") throw new FencedActivation();
    records.push({
      offset: result.offset,
      eventId: `journal:${lease.sessionId}:${result.offset}`,
      sessionId: lease.sessionId,
      ownerEpoch: lease.epoch,
      payload: structuredClone(payload),
    });
    return records;
  }
}

function* releaseClosed(options: CrankRuntimeOptions, lease: Lease, head: number): Operation<void> {
  const released = yield* options.store.closeAndRelease(lease, head);
  if (released === "fenced") throw new FencedActivation();
  if (released === "head_changed") {
    const records = yield* options.store.readJournal(lease.sessionId);
    return yield* releaseClosed(options, lease, records.length);
  }
}

function findActiveTurn(records: JournalRecord[]): ActiveTurn | undefined {
  return records
    .filter(
      (record): record is JournalRecord & { payload: ActiveTurn } =>
        record.payload.type === "turn_opened",
    )
    .map((record) => record.payload)
    .find(
      (turn) =>
        !records.some(
          (record) =>
            record.payload.type === "task_closed" && record.payload.taskId === turn.taskId,
        ),
    );
}

function nextUnconsumedSend(
  records: JournalRecord[],
): Extract<SessionCommand, { type: "send" }> | undefined {
  const consumed = new Set(
    records
      .filter((record) => record.payload.type === "turn_opened")
      .map((record) => (record.payload as ActiveTurn).commandId),
  );
  return records
    .map((record) => record.payload)
    .filter(
      (payload): payload is Extract<JournalPayload, { type: "command" }> =>
        payload.type === "command",
    )
    .map((payload) => payload.command)
    .find(
      (command): command is Extract<SessionCommand, { type: "send" }> =>
        command.type === "send" && !consumed.has(command.commandId),
    );
}

function unconsumedCommand<K extends SessionCommand["type"]>(
  records: JournalRecord[],
  kind: K,
): Extract<SessionCommand, { type: K }> | undefined {
  const consumed = new Set<string>();
  for (const record of records) {
    if (record.payload.type === "turn_opened" || record.payload.type === "session_closed")
      consumed.add(record.payload.commandId);
    if (record.payload.type === "pull_resolved" && record.payload.commandId)
      consumed.add(record.payload.commandId);
    if (record.payload.type === "task_closed" && record.payload.commandId)
      consumed.add(record.payload.commandId);
  }
  return records
    .filter(
      (
        record,
      ): record is JournalRecord & { payload: Extract<JournalPayload, { type: "command" }> } =>
        record.payload.type === "command",
    )
    .map((record) => record.payload.command)
    .find(
      (command): command is Extract<SessionCommand, { type: K }> =>
        command.type === kind && !consumed.has(command.commandId),
    );
}

function cancellationFor(
  records: JournalRecord[],
  turnId: string,
): Extract<SessionCommand, { type: "cancel_turn" }> | undefined {
  const command = unconsumedCommand(records, "cancel_turn");
  return command?.turnId === turnId ? command : undefined;
}

function responseFor(
  records: JournalRecord[],
  pullId: string,
): Extract<SessionCommand, { type: "respond" }> | undefined {
  const command = unconsumedCommand(records, "respond");
  return command?.pullId === pullId
    ? command
    : records
        .filter(
          (
            record,
          ): record is JournalRecord & { payload: Extract<JournalPayload, { type: "command" }> } =>
            record.payload.type === "command",
        )
        .map((record) => record.payload.command)
        .find(
          (candidate): candidate is Extract<SessionCommand, { type: "respond" }> =>
            candidate.type === "respond" &&
            candidate.pullId === pullId &&
            !records.some(
              (record) =>
                record.payload.type === "pull_resolved" &&
                record.payload.commandId === candidate.commandId,
            ),
        );
}

function openedUnclosedTasks(records: JournalRecord[], turnId: string): string[] {
  const opened = records.flatMap((record) => {
    if (record.payload.type === "turn_opened" && record.payload.turnId === turnId)
      return [record.payload.taskId];
    if (record.payload.type === "task_opened" && record.payload.turnId === turnId)
      return [record.payload.taskId];
    return [];
  });
  const closed = new Set(
    records
      .filter((record) => record.payload.type === "task_closed")
      .map((record) => (record.payload as Extract<JournalPayload, { type: "task_closed" }>).taskId),
  );
  return opened.filter((taskId) => !closed.has(taskId));
}

function stablePullId(
  sessionId: string,
  turnId: string,
  taskId: string,
  pullIndex: number,
): string {
  return stableOpaqueId("pull", [sessionId, turnId, taskId, pullIndex]);
}

function childCount(descriptor: PullDescriptor): number {
  if (descriptor.kind === "invoke") return 1;
  if (descriptor.kind === "all") return descriptor.children.length;
  return 0;
}

function lookup<T>(
  registry: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined,
  id: string,
): T | undefined {
  if (!registry) return undefined;
  return registry instanceof Map ? registry.get(id) : (registry as Readonly<Record<string, T>>)[id];
}

function isOperation(value: unknown): value is Operation<Json> {
  return Boolean(
    value && typeof value === "object" && typeof (value as { next?: unknown }).next === "function",
  );
}

function serializeError(error: unknown): { code: string; message: string; details?: Json } {
  if (error instanceof PullApplicationError) return error.applicationError;
  if (error instanceof CrankError)
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  return { code: "effect_error", message: error instanceof Error ? error.message : String(error) };
}

function taskResultEquals(left: TaskResult, right: Result): boolean {
  return left.status === "ok" || left.status === "error" || left.status === "cancelled"
    ? resultEquals(left, right)
    : false;
}

function requireId(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new CrankError("invalid_pull", "Symbolic IDs must be non-empty");
  return value;
}
