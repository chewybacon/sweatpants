import { scoped, type Operation } from "effection";
import type { Handler } from "@sweatpants/primitive-journal";
import type { Json } from "@sweatpants/foundation";
import type { ProgramCheckpoint } from "@sweatpants/durable-execution";
import type { BackendComputation, NativeWorkComputation } from "./program-backend.ts";
import { executeNativeWork } from "./native-work.ts";
import {
  driveProgramExecution,
  type ProgramExecutionState,
  type ProgramRequest,
  type ProgramReply,
} from "./program-execution.ts";
import {
  ProgramEffectRuntimeContext,
  type ProgramEffectRuntime,
} from "./program-effect-runtime.ts";

type Yielded =
  ReturnType<Operation<unknown>[typeof Symbol.iterator]> extends Iterator<infer Y, unknown, unknown>
    ? Y
    : never;
export type ProgramHandler = Handler<ProgramRequest, Yielded, ProgramReply>;
export interface ProgramKernel {
  run(handle: ProgramHandler): Operation<Json>;
  capture(): Operation<ProgramCheckpoint>;
  dispose(): Operation<void>;
}

/** Computation capabilities stay native; only their request interpretation is shared. */
export function createProgramKernel(
  computation:
    | BackendComputation
    | (() => Operation<Json>)
    | { start(): Operation<ProgramExecutionState> },
): ProgramKernel {
  let started = false;
  let disposed = false;
  return {
    *run(handle) {
      if (started || disposed) {
        throw new Error("execution_closed");
      }
      started = true;
      const runtime: ProgramEffectRuntime = {
        *perform(boundary) {
          const reply = yield* handle({ kind: "record", boundary });
          if (reply.kind !== "record") {
            throw new Error("record reply mismatch");
          }
          return reply.outcome;
        },
        *requestEmission(descriptor) {
          const reply = yield* handle({ kind: "emission", descriptor });
          if (reply.kind !== "emission") {
            throw new Error("emission reply mismatch");
          }
          return reply.value;
        },
      };
      if (typeof computation === "function" || "work" in computation) {
        const work: NativeWorkComputation["work"] =
          typeof computation === "function" ? computation : computation.work;
        return yield* executeNativeWork(work, runtime);
      }
      return yield* scoped(function* () {
        yield* ProgramEffectRuntimeContext.set(runtime);
        return yield* driveProgramExecution(() => computation.start());
      });
    },
    *capture() {
      return typeof computation !== "function" && "capture" in computation
        ? yield* computation.capture()
        : { kind: "replay" };
    },
    *dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (typeof computation !== "function" && "dispose" in computation) {
        yield* computation.dispose();
      }
    },
  };
}
