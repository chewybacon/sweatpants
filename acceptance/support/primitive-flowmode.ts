import type { Operation } from "effection";
import { assertJson } from "@sweatpants/foundation";
import type { DurableOperationDescriptor } from "@sweatpants/durable-execution";
import { loadKernelProgram, type KernelProgramBundle } from "@sweatpants/flowmode-backend";
import { createLuaKernel } from "@sweatpants/flowmode-runtime-lua/kernel";
import { invokeWasm } from "@sweatpants/flowmode-runtime-lua/node";
import type {
  ExchangeRequest,
  WorkflowBoundary,
  WorkflowExecution,
} from "@sweatpants/flowmode-runtime";
import {
  encode,
  type GuestWork,
  type Identity,
  type IterableOperation,
  type Json,
  type Turn,
} from "@sweatpants/primitive-journal";

type NativeYield = Operation<unknown> extends IterableOperation<unknown, infer Y> ? Y : never;

export interface KernelTrace {
  readonly phase: string;
  readonly events: Json[];
}

/** Descriptor translation only: workflow decisions and cleanup remain in compiled Lua. */
export function createPrimitiveLuaWork(
  bundle: KernelProgramBundle,
  identity: Identity,
  bindOperation: (request: ExchangeRequest) => DurableOperationDescriptor,
  trace: KernelTrace,
): GuestWork<Json, Json, NativeYield, Json, Json> {
  return function* () {
    const program = loadKernelProgram(bundle, identity.program.digest);
    const kernel = createLuaKernel(invokeWasm);
    trace.events.push({ event: "allocate" });
    let execution: WorkflowExecution | undefined;
    let current: WorkflowBoundary | undefined;
    let started = false;
    let closed = false;
    function map(boundary: WorkflowBoundary): Turn<Json, Json> {
      current = boundary;
      trace.events.push({ event: "boundary", boundary: assertJson(boundary) });
      if (boundary.kind === "completed") {
        return { kind: "completed", value: boundary.value };
      }
      if (boundary.kind !== "suspended") {
        throw new Error(`Native Lua terminal boundary: ${encode(boundary)}`);
      }
      const descriptor = bindOperation(boundary.request);
      if (descriptor.kind !== "elicit") {
        throw new Error("Primitive Lua adapter supports only elicit descriptors");
      }
      return {
        kind: "suspended",
        request: assertJson({ exchange: boundary.request, descriptor }),
      };
    }
    return {
      *start() {
        if (started || closed) {
          throw new Error("Guest start requires a fresh cursor");
        }
        started = true;
        trace.events.push({ event: "start" });
        const live = yield* kernel.start(program, assertJson(JSON.parse(encode(identity.input))));
        execution = live.execution;
        return map(live.boundary);
      },
      *resume(outcome) {
        if (closed || !execution || current?.kind !== "suspended") {
          throw new Error("Guest resume requires a suspended cursor");
        }
        const suspensionId = current.suspensionId;
        const reply = outcome.ok
          ? { kind: "value" as const, value: assertJson(outcome.value) }
          : { kind: "throw" as const, value: assertJson(outcome.error) };
        current = undefined;
        trace.events.push({ event: "resume", suspensionId, reply });
        return map(yield* execution.resume(suspensionId, reply));
      },
      *close() {
        if (closed) {
          return;
        }
        closed = true;
        try {
          if (execution) {
            yield* execution.dispose();
            trace.events.push({ event: "dispose" });
          }
        } finally {
          yield* kernel.close();
          trace.events.push({ event: "close" });
        }
      },
    };
  };
}
