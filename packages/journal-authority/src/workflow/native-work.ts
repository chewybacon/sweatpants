import { scoped, type Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { NativeWorkComputation } from "./program-backend.ts";
import {
  ProgramEffectRuntimeContext,
  type ProgramEffectRuntime,
} from "./program-effect-runtime.ts";

/** One native scope and one outstanding boundary, shared by records and emissions. */
export function executeNativeWork(
  work: NativeWorkComputation["work"],
  runtime: ProgramEffectRuntime,
): Operation<Json> {
  return scoped(function* () {
    let pending = false;
    let closed = false;
    function* request<T>(operation: () => Operation<T>): Operation<T> {
      if (closed) {
        throw new Error("execution_closed");
      }
      if (pending) {
        throw new Error("concurrent_kernel_request");
      }
      pending = true;
      try {
        return yield* operation();
      } finally {
        pending = false;
      }
    }
    yield* ProgramEffectRuntimeContext.set({
      *perform(boundary) {
        return yield* request(() => runtime.perform(boundary));
      },
      *requestEmission(descriptor) {
        return yield* request(() => runtime.requestEmission(descriptor));
      },
    });
    try {
      return yield* work();
    } finally {
      closed = true;
    }
  });
}
