import type { Operation } from "effection";
import { assertJson, createExecution, type Json } from "@sweatpants/foundation";
import {
  CrankError,
  DurableProgramCancellation,
  type DurableOperationDescriptor,
} from "@sweatpants/durable-execution";
import {
  InstalledEffectPort,
  type ProgramExecutionState,
  type ProgramReply,
} from "@sweatpants/journal-authority";
import type {
  ExchangeRequest,
  KernelSnapshot,
  WorkflowBoundary,
  WorkflowExecutionState,
} from "@sweatpants/flowmode-runtime";
import {
  createGuest,
  failure,
  success,
  type Outcome,
  type Guest,
  type Turn,
  type Work,
} from "@sweatpants/foundation/computation";

type EffectionYielded =
  ReturnType<Operation<unknown>[typeof Symbol.iterator]> extends Iterator<infer Y, unknown, unknown>
    ? Y
    : never;
type NativeTurn = Turn<Json, ExchangeRequest>;
export interface KernelGuest {
  guest: Guest<Json, ExchangeRequest, EffectionYielded, Json, Json>;
  cancel(reason?: string): Operation<NativeTurn>;
  capture(): Operation<KernelSnapshot>;
}

/** A native cursor supplies one boundary per operation; it never interprets requests. */
export function* createKernelGuest(
  start: () => Operation<WorkflowExecutionState>,
): Operation<KernelGuest> {
  let state: WorkflowExecutionState | undefined;
  let boundary: WorkflowBoundary | undefined;
  function turn(next: WorkflowBoundary): NativeTurn {
    boundary = next;
    if (next.kind === "failed") {
      throw new CrankError("workflow_failed", JSON.stringify(next.error));
    }
    if (next.kind === "cancelled") {
      throw new DurableProgramCancellation(next.reason);
    }
    return next.kind === "completed"
      ? { kind: "completed", value: next.value }
      : { kind: "suspended", request: next.request };
  }
  const guest = createGuest<Json, ExchangeRequest, EffectionYielded, Json, Json>({
    *start() {
      state = yield* start();
      return turn(state.boundary);
    },
    *resume(outcome: Outcome<Json, Json>) {
      if (!state || boundary?.kind !== "suspended") {
        throw new Error("kernel_not_suspended");
      }
      return turn(
        yield* state.execution.resume(
          boundary.suspensionId,
          outcome.ok
            ? { kind: "value", value: outcome.value }
            : { kind: "throw", value: outcome.error },
        ),
      );
    },
    *close() {
      if (state) {
        yield* state.execution.dispose();
      }
    },
  });
  return {
    guest,
    *cancel(reason) {
      if (!state) {
        throw new Error("kernel_not_started");
      }
      return turn(yield* state.execution.cancel(reason));
    },
    *capture() {
      if (!state) {
        throw new CrankError("program_protocol_error", "Computation is unavailable");
      }
      return yield* state.execution.capture();
    },
  };
}

/** Foundation owns command discipline; the shared attachment owns interpretation. */
export function* startKernelGuest(
  cursor: KernelGuest,
  bindOperation: (request: ExchangeRequest) => DurableOperationDescriptor,
  failed: () => void,
): Operation<ProgramExecutionState> {
  let sequence = 0;
  function* advance(
    work: Work<NativeTurn, EffectionYielded>,
  ): Operation<ProgramExecutionState["boundary"]> {
    try {
      const turn = yield* work();
      if (turn.kind === "completed") {
        return turn;
      }
      const descriptor = bindOperation(turn.request);
      return {
        kind: "suspended",
        suspensionId: String(++sequence),
        request: {
          kind: "record",
          boundary: {
            serializable: { type: "operation", descriptor },
            *execute(attempt) {
              if (descriptor.kind !== "effect") {
                throw new CrankError(
                  "program_protocol_error",
                  "Operation settles through the host",
                );
              }
              return yield* InstalledEffectPort.api.operations.run(descriptor, attempt);
            },
          },
        },
      };
    } catch (error) {
      if (error instanceof DurableProgramCancellation) {
        return { kind: "cancelled", reason: error.reason };
      }
      failed();
      return { kind: "failed", error };
    }
  }
  return createExecution({
    initial: yield* advance(() => cursor.guest.start()),
    validateReply(_request, reply: ProgramReply) {
      if (reply.kind !== "record") {
        throw new Error("kernel_reply_mismatch");
      }
    },
    driver: {
      *resume(_id, reply: ProgramReply) {
        return yield* advance(function* () {
          if (reply.kind !== "record") {
            throw new Error("kernel_reply_mismatch");
          }
          const outcome = reply.outcome;
          if (outcome.status === "cancelled") {
            return yield* cursor.cancel();
          }
          return yield* cursor.guest.resume(
            outcome.status === "ok" ? success(outcome.value) : failure(assertJson(outcome.error)),
          );
        });
      },
      cancel: (reason) => advance(() => cursor.cancel(reason)),
      dispose: () => cursor.guest.close(),
    },
  });
}
