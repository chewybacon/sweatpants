import type { Operation } from "effection";
import type { Json, ExecutionState } from "@sweatpants/foundation";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import { DurableProgramCancellation, type EmissionDescriptor } from "@sweatpants/durable-execution";
import {
  ProgramEffectRuntimeContext,
  type RuntimeRecordBoundary,
} from "./program-effect-runtime.ts";

/** Local requests carry capabilities, including effect attempt closures; not wire data. */
export type ProgramRequest =
  | { kind: "record"; boundary: RuntimeRecordBoundary<Json> }
  | { kind: "emission"; descriptor: EmissionDescriptor };
export type ProgramReply =
  | { kind: "record"; outcome: OperationOutcome }
  | { kind: "emission"; value: Json };
export type ProgramExecutionState = ExecutionState<ProgramRequest, ProgramReply, Json>;

/** The attachment drives every evaluator through this one loop. */
export function* driveProgramExecution(
  start: () => Operation<ProgramExecutionState>,
): Operation<Json> {
  const container = yield* ProgramEffectRuntimeContext.expect();
  const { execution, boundary: initial } = yield* start();
  let boundary = initial;
  try {
    while (boundary.kind === "suspended") {
      const { request, suspensionId } = boundary;
      let reply: ProgramReply;
      try {
        if (request.kind === "record") {
          const outcome = yield* container.perform(request.boundary);
          reply = { kind: "record", outcome };
        } else {
          const value = yield* container.requestEmission(request.descriptor);
          reply = { kind: "emission", value };
        }
      } catch (error) {
        if (!(error instanceof DurableProgramCancellation)) {
          throw error;
        }
        boundary = yield* execution.cancel(error.reason);
        continue;
      }
      boundary = yield* execution.resume(suspensionId, reply);
    }
    if (boundary.kind === "failed") {
      throw boundary.error;
    }
    if (boundary.kind === "cancelled") {
      throw new DurableProgramCancellation(boundary.reason);
    }
    return boundary.value;
  } finally {
    // Terminal state remains available for checkpoint capture until the
    // attachment owner disposes its computation. Interrupted turns release now.
    if (boundary.kind === "suspended") {
      yield* execution.dispose();
    }
  }
}
